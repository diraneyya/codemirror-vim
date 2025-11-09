/**
 * VimStateManager - Centralized state management for Vim mode robustness
 *
 * This module provides a single source of truth for Vim state to prevent
 * state fragmentation and inconsistencies that lead to bugs like:
 * - Status showing "Vim (Normal)" while Vim shortcuts don't work
 * - Character leaking into document in normal mode
 * - Inconsistent mode transitions
 */

import type { EditorView } from "@codemirror/view";
import type { CodeMirror } from "./cm_adapter";

export type VimMode = 'normal' | 'insert' | 'visual' | 'replace' | 'command';
export type VimSubMode = 'linewise' | 'blockwise' | null;

export interface VimState {
  mode: VimMode;
  subMode: VimSubMode;
  isTransitioning: boolean;
  lastValidState: VimState | null;
}

export interface VimStateChangeEvent {
  oldState: VimState;
  newState: VimState;
  source: 'plugin' | 'command' | 'recovery';
}

export type VimStateChangeListener = (event: VimStateChangeEvent) => void;

/**
 * Singleton state manager that provides centralized, validated state management
 */
export class VimStateManager {
  private static instance: VimStateManager | null = null;

  private currentState: VimState = {
    mode: 'normal',
    subMode: null,
    isTransitioning: false,
    lastValidState: null
  };

  private listeners: Set<VimStateChangeListener> = new Set();
  private editorViews: Map<string, { view: EditorView; cm: CodeMirror }> = new Map();
  private recoveryInProgress: boolean = false;

  private constructor() {}

  public static getInstance(): VimStateManager {
    if (!VimStateManager.instance) {
      VimStateManager.instance = new VimStateManager();
    }
    return VimStateManager.instance;
  }

  /**
   * Register an editor view with the state manager
   */
  public registerEditor(viewId: string, view: EditorView, cm: CodeMirror): void {
    this.editorViews.set(viewId, { view, cm });

    // Sync initial state
    this.syncStateToEditor(viewId);
  }

  /**
   * Unregister an editor view
   */
  public unregisterEditor(viewId: string): void {
    this.editorViews.delete(viewId);
  }

  /**
   * Get the current vim mode
   */
  public getMode(): VimMode {
    return this.currentState.mode;
  }

  /**
   * Get the current vim sub-mode
   */
  public getSubMode(): VimSubMode {
    return this.currentState.subMode;
  }

  /**
   * Get the complete current state
   */
  public getState(): Readonly<VimState> {
    return { ...this.currentState };
  }

  /**
   * Check if vim is currently in insert mode (should allow text input)
   */
  public isInInsertMode(): boolean {
    return this.currentState.mode === 'insert' || this.currentState.mode === 'replace';
  }

  /**
   * Check if vim is in a mode that should block text input
   */
  public shouldBlockInput(): boolean {
    return !this.isInInsertMode() && !this.currentState.isTransitioning;
  }

  /**
   * Transition to a new vim mode with validation
   */
  public transitionTo(newMode: VimMode, newSubMode: VimSubMode = null, source: 'plugin' | 'command' | 'recovery' = 'plugin'): boolean {
    // Prevent recursive transitions during recovery
    if (this.recoveryInProgress && source !== 'recovery') {
      console.warn('[VimStateManager] Blocked transition during recovery');
      return false;
    }

    // Validate transition
    if (!this.isValidTransition(this.currentState.mode, newMode)) {
      console.warn(`[VimStateManager] Invalid transition from ${this.currentState.mode} to ${newMode}`);
      return false;
    }

    // Store old state for event
    const oldState = { ...this.currentState };

    // Store last valid state for recovery
    if (!this.currentState.isTransitioning) {
      this.currentState.lastValidState = { ...oldState };
    }

    // Mark as transitioning
    this.currentState.isTransitioning = true;

    try {
      // Update state
      this.currentState.mode = newMode;
      this.currentState.subMode = newSubMode;

      // Sync to all registered editors
      for (const [viewId] of this.editorViews) {
        this.syncStateToEditor(viewId);
      }

      // Complete transition
      this.currentState.isTransitioning = false;

      // Notify listeners
      const changeEvent: VimStateChangeEvent = {
        oldState,
        newState: { ...this.currentState },
        source
      };

      this.notifyListeners(changeEvent);

      console.log(`[VimStateManager] Transitioned from ${oldState.mode} to ${newMode}${newSubMode ? ` (${newSubMode})` : ''}`);
      return true;

    } catch (error) {
      console.error('[VimStateManager] Error during transition:', error);

      // Attempt recovery to last valid state
      this.attemptRecovery();
      return false;
    }
  }

  /**
   * Validate that a state transition is allowed
   */
  private isValidTransition(fromMode: VimMode, toMode: VimMode): boolean {
    // Allow all transitions for now, but we can add validation rules here
    // Example rules:
    // - normal -> insert/visual/command ✓
    // - insert -> normal (via Escape) ✓
    // - visual -> normal/command ✓
    // etc.

    return true; // For now, allow all transitions
  }

  /**
   * Sync state to a specific editor
   */
  private syncStateToEditor(viewId: string): void {
    const editor = this.editorViews.get(viewId);
    if (!editor) return;

    const { view, cm } = editor;

    try {
      // Sync to CodeMirror 5 adapter state
      if (cm.state.vim) {
        cm.state.vim.mode = this.currentState.mode;
        if (this.currentState.subMode) {
          cm.state.vim.mode += this.currentState.subMode === 'linewise' ? ' line' : ' block';
        }
      }

      // Update CSS classes for visual feedback
      if (this.isInInsertMode()) {
        view.scrollDOM.classList.remove('cm-vimMode');
      } else {
        view.scrollDOM.classList.add('cm-vimMode');
      }

      // Update content editable state
      if (this.shouldBlockInput()) {
        view.contentDOM.setAttribute('contenteditable', 'false');
      } else {
        view.contentDOM.setAttribute('contenteditable', 'true');
      }

    } catch (error) {
      console.error(`[VimStateManager] Error syncing state to editor ${viewId}:`, error);
    }
  }

  /**
   * Detect and recover from state inconsistencies
   */
  public detectAndRecover(): boolean {
    for (const [viewId, { cm }] of this.editorViews) {
      if (!cm.state.vim) continue;

      // Check for inconsistency between our state and vim plugin state
      const vimPluginMode = cm.state.vim.mode?.replace(/ (line|block)$/, '') as VimMode;

      if (vimPluginMode && vimPluginMode !== this.currentState.mode && !this.currentState.isTransitioning) {
        console.warn(`[VimStateManager] Detected state inconsistency in ${viewId}: ours=${this.currentState.mode}, vim=${vimPluginMode}`);

        // Attempt recovery
        return this.attemptRecovery();
      }
    }

    return true; // No inconsistencies detected
  }

  /**
   * Attempt to recover from an invalid state
   */
  private attemptRecovery(): boolean {
    if (this.recoveryInProgress) {
      console.error('[VimStateManager] Recovery already in progress');
      return false;
    }

    this.recoveryInProgress = true;

    try {
      // Try to recover to last valid state
      if (this.currentState.lastValidState) {
        console.log('[VimStateManager] Attempting recovery to last valid state:', this.currentState.lastValidState);

        const recoveryState = this.currentState.lastValidState;
        this.currentState = {
          ...recoveryState,
          isTransitioning: false,
          lastValidState: null
        };
      } else {
        // Fallback to safe normal mode
        console.log('[VimStateManager] Fallback recovery to normal mode');
        this.currentState = {
          mode: 'normal',
          subMode: null,
          isTransitioning: false,
          lastValidState: null
        };
      }

      // Force sync to all editors
      for (const [viewId] of this.editorViews) {
        this.syncStateToEditor(viewId);
      }

      // Notify listeners of recovery
      this.notifyListeners({
        oldState: this.currentState, // Recovery event
        newState: { ...this.currentState },
        source: 'recovery'
      });

      console.log('[VimStateManager] Recovery completed successfully');
      return true;

    } catch (error) {
      console.error('[VimStateManager] Recovery failed:', error);
      return false;
    } finally {
      this.recoveryInProgress = false;
    }
  }

  /**
   * Add a state change listener
   */
  public addStateChangeListener(listener: VimStateChangeListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a state change listener
   */
  public removeStateChangeListener(listener: VimStateChangeListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state changes
   */
  private notifyListeners(event: VimStateChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[VimStateManager] Error in state change listener:', error);
      }
    }
  }

  /**
   * Reset the state manager (for testing)
   */
  public reset(): void {
    this.currentState = {
      mode: 'normal',
      subMode: null,
      isTransitioning: false,
      lastValidState: null
    };
    this.editorViews.clear();
    this.listeners.clear();
    this.recoveryInProgress = false;
  }

  /**
   * Get debug information about the current state
   */
  public getDebugInfo(): object {
    return {
      currentState: this.currentState,
      registeredEditors: Array.from(this.editorViews.keys()),
      listenerCount: this.listeners.size,
      recoveryInProgress: this.recoveryInProgress
    };
  }
}