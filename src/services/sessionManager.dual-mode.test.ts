import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SessionManager} from './sessionManager.js';
import {configurationManager} from './configurationManager.js';
import {spawn, IPty} from 'node-pty';
import {EventEmitter} from 'events';
import {TerminalMode} from '../types/index.js';

// Mock node-pty
vi.mock('node-pty');

// Mock configuration manager
vi.mock('./configurationManager.js', () => ({
	configurationManager: {
		getCommandConfig: vi.fn(),
		getStatusHooks: vi.fn(() => ({})),
	},
}));

// Mock Terminal
vi.mock('@xterm/headless', () => ({
	default: {
		Terminal: vi.fn().mockImplementation(() => ({
			buffer: {
				active: {
					length: 0,
					getLine: vi.fn(),
				},
			},
			write: vi.fn(),
		})),
	},
}));

// Create a mock IPty class
class MockPty extends EventEmitter {
	kill = vi.fn();
	resize = vi.fn();
	write = vi.fn();
	onData = vi.fn((callback: (data: string) => void) => {
		this.on('data', callback);
	});
	onExit = vi.fn(
		(callback: (e: {exitCode: number; signal?: number}) => void) => {
			this.on('exit', callback);
		},
	);
}

describe('SessionManager - Dual Mode Features', () => {
	let sessionManager: SessionManager;
	let mockPty: MockPty;

	beforeEach(() => {
		vi.clearAllMocks();
		sessionManager = new SessionManager();
		mockPty = new MockPty();
	});

	afterEach(() => {
		sessionManager.destroy();
	});

	describe('dual-mode session initialization', () => {
		it('should initialize session with Claude mode as default', async () => {
			// Setup mock configuration
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});

			// Setup spawn mock
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Verify dual-mode properties are initialized
			expect(session.currentMode).toBe('claude');
			expect(session.bashProcess).toBeUndefined();
			expect(session.bashHistory).toEqual([]);
		});

		it('should handle session with pre-existing bash process', async () => {
			// Setup mock configuration
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});

			// Setup spawn mock
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Simulate adding bash process
			const mockBashPty = new MockPty();
			session.bashProcess = mockBashPty as unknown as IPty;
			session.currentMode = 'bash';

			// Verify state is preserved
			expect(session.currentMode).toBe('bash');
			expect(session.bashProcess).toBe(mockBashPty);
		});
	});

	describe('dual-mode cleanup', () => {
		it('should clean up bash process when session is destroyed', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Add bash process
			const mockBashPty = new MockPty();
			session.bashProcess = mockBashPty as unknown as IPty;

			// Destroy session
			sessionManager.destroySession('/test/worktree');

			// Verify both processes are cleaned up
			expect(mockPty.kill).toHaveBeenCalled(); // Claude process
			expect(mockBashPty.kill).toHaveBeenCalled(); // Bash process
			expect(sessionManager.getSession('/test/worktree')).toBeUndefined();
		});

		it('should handle bash process cleanup when bash process is null', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session (no bash process)
			await sessionManager.createSession('/test/worktree');

			// Should not throw when destroying session without bash process
			expect(() => {
				sessionManager.destroySession('/test/worktree');
			}).not.toThrow();

			// Verify main process cleanup still occurs
			expect(mockPty.kill).toHaveBeenCalled();
		});

		it('should handle error when bash process kill fails', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Add bash process that throws on kill
			const mockBashPty = new MockPty();
			mockBashPty.kill.mockImplementation(() => {
				throw new Error('Kill failed');
			});
			session.bashProcess = mockBashPty as unknown as IPty;

			// Should not throw when cleanup fails
			expect(() => {
				sessionManager.destroySession('/test/worktree');
			}).not.toThrow();

			// Verify cleanup was attempted
			expect(mockBashPty.kill).toHaveBeenCalled();
		});
	});

	describe('bash history management', () => {
		it('should initialize bash history as empty array', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Verify bash history is initialized
			expect(session.bashHistory).toEqual([]);
		});

		it('should preserve bash history during session lifecycle', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Simulate bash history
			const testHistory = [Buffer.from('$ ls\n'), Buffer.from('file1.txt\n')];
			session.bashHistory = testHistory;

			// Verify history is preserved
			expect(session.bashHistory).toBe(testHistory);
			expect(session.bashHistory.length).toBe(2);
		});
	});

	describe('terminal mode state management', () => {
		it('should track current mode changes', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Test mode changes
			expect(session.currentMode).toBe('claude');

			session.currentMode = 'bash';
			expect(session.currentMode).toBe('bash');

			session.currentMode = 'claude';
			expect(session.currentMode).toBe('claude');
		});

		it('should validate terminal mode values', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Test valid modes
			const validModes: TerminalMode[] = ['claude', 'bash'];

			for (const mode of validModes) {
				session.currentMode = mode;
				expect(session.currentMode).toBe(mode);
			}
		});
	});

	describe('resource management with dual PTY instances', () => {
		it('should handle memory cleanup for bash history', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Simulate large bash history
			const largeBuffer = Buffer.alloc(1024 * 1024); // 1MB buffer
			session.bashHistory = Array(10).fill(largeBuffer); // 10MB total

			// Verify history exists
			expect(session.bashHistory.length).toBe(10);

			// Cleanup should handle large history gracefully
			expect(() => {
				sessionManager.destroySession('/test/worktree');
			}).not.toThrow();
		});

		it('should handle concurrent access to dual PTY instances', async () => {
			// Setup
			vi.mocked(configurationManager.getCommandConfig).mockReturnValue({
				command: 'claude',
			});
			vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);

			// Create session
			const session = await sessionManager.createSession('/test/worktree');

			// Add bash process
			const mockBashPty = new MockPty();
			session.bashProcess = mockBashPty as unknown as IPty;

			// Simulate concurrent operations
			const operations = [
				() => session.process.write('test claude'),
				() => session.bashProcess?.write('test bash'),
				() => sessionManager.setSessionActive('/test/worktree', true),
				() => sessionManager.setSessionActive('/test/worktree', false),
			];

			// Should not throw during concurrent access
			expect(() => {
				operations.forEach(op => op());
			}).not.toThrow();
		});
	});
});
