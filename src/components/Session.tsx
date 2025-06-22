import React, {useCallback, useEffect, useState} from 'react';
import {useStdout} from 'ink';
import {Session as SessionType, TerminalMode} from '../types/index.js';
import {SessionManager} from '../services/sessionManager.js';
import {shortcutManager} from '../services/shortcutManager.js';
import {spawn, IPty} from 'node-pty';

interface SessionProps {
	session: SessionType;
	sessionManager: SessionManager;
	onReturnToMenu: () => void;
}

const Session: React.FC<SessionProps> = ({
	session,
	sessionManager,
	onReturnToMenu,
}) => {
	const {stdout} = useStdout();
	const [isExiting, setIsExiting] = useState(false);
	const [currentMode, setCurrentMode] = useState<TerminalMode>(
		session.currentMode || 'claude',
	);
	const [bashProcess, setBashProcess] = useState<IPty | null>(
		session.bashProcess || null,
	);

	// Create bash PTY on-demand
	const createBashProcess = useCallback(() => {
		if (bashProcess) return bashProcess;

		const bashPty = spawn('/bin/bash', [], {
			name: 'xterm-color',
			cols: process.stdout.columns || 80,
			rows: process.stdout.rows || 24,
			cwd: session.worktreePath,
			env: process.env,
		});

		// Set up data handler for bash PTY
		bashPty.onData((data: string) => {
			if (currentMode === 'bash' && !isExiting) {
				stdout.write(data);
			}
			// Store bash history for session restoration
			if (!session.bashHistory) {
				session.bashHistory = [];
			}
			session.bashHistory.push(Buffer.from(data, 'utf8'));

			// Limit bash history memory usage
			const MAX_BASH_HISTORY_SIZE = 5 * 1024 * 1024; // 5MB
			let totalSize = session.bashHistory.reduce(
				(sum, buf) => sum + buf.length,
				0,
			);
			while (
				totalSize > MAX_BASH_HISTORY_SIZE &&
				session.bashHistory.length > 0
			) {
				const removed = session.bashHistory.shift();
				if (removed) {
					totalSize -= removed.length;
				}
			}
		});

		// Store reference in session for cleanup
		session.bashProcess = bashPty;
		setBashProcess(bashPty);

		return bashPty;
	}, [bashProcess, currentMode, isExiting, session, stdout]);

	// Display visual mode indicator
	const displayModeIndicator = useCallback(
		(mode: TerminalMode) => {
			if (!stdout) return;

			const indicator =
				mode === 'claude'
					? '\x1b[44m Claude \x1b[0m \x1b[90m(Ctrl+T: Bash)\x1b[0m'
					: '\x1b[42m Bash \x1b[0m \x1b[90m(Ctrl+T: Claude)\x1b[0m';

			// Display in status line at top of terminal
			stdout.write(`\x1b[s\x1b[1;1H${indicator}\x1b[u`);
		},
		[stdout],
	);

	// Toggle between Claude and Bash modes
	const toggleMode = useCallback(() => {
		if (currentMode === 'claude') {
			// Switch to bash mode
			createBashProcess();
			setCurrentMode('bash');
			session.currentMode = 'bash';
			displayModeIndicator('bash');

			// Restore bash history if available
			if (session.bashHistory && session.bashHistory.length > 0) {
				// Only restore if bash just started (empty screen)
				// This prevents double output when switching back
			}
		} else {
			// Switch to claude mode
			setCurrentMode('claude');
			session.currentMode = 'claude';
			displayModeIndicator('claude');
		}
	}, [currentMode, session, displayModeIndicator, createBashProcess]);

	useEffect(() => {
		if (!stdout) return;

		// Clear screen when entering session
		stdout.write('\x1B[2J\x1B[H');

		// Handle session restoration
		const handleSessionRestore = (restoredSession: SessionType) => {
			if (restoredSession.id === session.id) {
				// Replay all buffered output, but skip the initial clear if present
				for (let i = 0; i < restoredSession.outputHistory.length; i++) {
					const buffer = restoredSession.outputHistory[i];
					if (!buffer) continue;

					const str = buffer.toString('utf8');

					// Skip clear screen sequences at the beginning
					if (i === 0 && (str.includes('\x1B[2J') || str.includes('\x1B[H'))) {
						// Skip this buffer or remove the clear sequence
						const cleaned = str
							.replace(/\x1B\[2J/g, '')
							.replace(/\x1B\[H/g, '');
						if (cleaned.length > 0) {
							stdout.write(Buffer.from(cleaned, 'utf8'));
						}
					} else {
						stdout.write(buffer);
					}
				}
			}
		};

		// Listen for restore event first
		sessionManager.on('sessionRestore', handleSessionRestore);

		// Mark session as active (this will trigger the restore event)
		sessionManager.setSessionActive(session.worktreePath, true);

		// Immediately resize the PTY and terminal to current dimensions
		// This fixes rendering issues when terminal width changed while in menu
		// https://github.com/kbwo/ccmanager/issues/2
		const currentCols = process.stdout.columns || 80;
		const currentRows = process.stdout.rows || 24;

		// Do not delete try-catch
		// Prevent ccmanager from exiting when claude process has already exited
		try {
			session.process.resize(currentCols, currentRows);
			if (session.terminal) {
				session.terminal.resize(currentCols, currentRows);
			}
		} catch {
			/* empty */
		}

		// Listen for session data events
		const handleSessionData = (activeSession: SessionType, data: string) => {
			// Only handle data for our session
			if (activeSession.id === session.id && !isExiting) {
				stdout.write(data);
			}
		};

		const handleSessionExit = (exitedSession: SessionType) => {
			if (exitedSession.id === session.id) {
				setIsExiting(true);
				// Don't call onReturnToMenu here - App component handles it
			}
		};

		sessionManager.on('sessionData', handleSessionData);
		sessionManager.on('sessionExit', handleSessionExit);

		// Handle terminal resize
		const handleResize = () => {
			const cols = process.stdout.columns || 80;
			const rows = process.stdout.rows || 24;
			session.process.resize(cols, rows);
			// Also resize the virtual terminal
			if (session.terminal) {
				session.terminal.resize(cols, rows);
			}
			// Resize bash PTY if it exists
			if (bashProcess) {
				try {
					bashProcess.resize(cols, rows);
				} catch (_error) {
					// Handle resize error gracefully
				}
			}
		};

		stdout.on('resize', handleResize);

		// Set up raw input handling
		const stdin = process.stdin;

		// Store original stdin state
		const originalIsRaw = stdin.isRaw;
		const originalIsPaused = stdin.isPaused();

		// Configure stdin for PTY passthrough
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');

		const handleStdinData = (data: string) => {
			if (isExiting) return;

			// Check for return to menu shortcut
			const shortcuts = shortcutManager.getShortcuts();
			const returnToMenuShortcut = shortcuts.returnToMenu;
			const returnToMenuCode =
				shortcutManager.getShortcutCode(returnToMenuShortcut);

			if (returnToMenuCode && data === returnToMenuCode) {
				// Disable focus reporting mode before returning to menu
				if (stdout) {
					stdout.write('\x1b[?1004l');
				}
				// Restore stdin state before returning to menu
				stdin.removeListener('data', handleStdinData);
				stdin.setRawMode(false);
				stdin.pause();
				onReturnToMenu();
				return;
			}

			// Check for mode toggle shortcut (Ctrl+T)
			const toggleModeShortcut = shortcuts.toggleMode;
			const toggleModeCode =
				shortcutManager.getShortcutCode(toggleModeShortcut);

			if (toggleModeCode && data === toggleModeCode) {
				toggleMode();
				return;
			}

			// Route input to appropriate PTY based on current mode
			if (currentMode === 'claude') {
				session.process.write(data);
			} else if (currentMode === 'bash' && bashProcess) {
				bashProcess.write(data);
			}
		};

		stdin.on('data', handleStdinData);

		// Display initial mode indicator
		displayModeIndicator(currentMode);

		return () => {
			// Remove listener first to prevent any race conditions
			stdin.removeListener('data', handleStdinData);

			// Disable focus reporting mode that might have been enabled by the PTY
			if (stdout) {
				stdout.write('\x1b[?1004l');
			}

			// Restore stdin to its original state
			if (stdin.isTTY) {
				stdin.setRawMode(originalIsRaw || false);
				if (originalIsPaused) {
					stdin.pause();
				} else {
					stdin.resume();
				}
			}

			// Mark session as inactive
			sessionManager.setSessionActive(session.worktreePath, false);

			// Remove event listeners
			sessionManager.off('sessionRestore', handleSessionRestore);
			sessionManager.off('sessionData', handleSessionData);
			sessionManager.off('sessionExit', handleSessionExit);
			stdout.off('resize', handleResize);
		};
	}, [
		session,
		sessionManager,
		stdout,
		onReturnToMenu,
		isExiting,
		bashProcess,
		currentMode,
		displayModeIndicator,
		toggleMode,
		createBashProcess,
	]);

	// Return null to render nothing (PTY output goes directly to stdout)
	return null;
};

export default Session;
