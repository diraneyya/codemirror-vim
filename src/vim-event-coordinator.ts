/**
 * VimEventCoordinator - Centralized event routing with priority handling
 *
 * This module provides robust event coordination to prevent conflicts between
 * standard editor operations (Ctrl+A, Ctrl+V) and vim commands, ensuring that:
 * - Standard editor shortcuts work properly even in normal mode
 * - Vim commands are processed correctly when appropriate
 * - Character leaking is prevented in non-insert modes
 * - Event conflicts are resolved with proper priority
 */

import type { EditorView } from "@codemirror/view";
import { VimStateManager, type VimMode } from "./vim-state-manager";

export interface EventHandlingResult {
  handled: boolean;
  preventDefault: boolean;
  stopPropagation: boolean;
  allowDefault: boolean;
}

export interface KeyEventContext {
  event: KeyboardEvent;
  view: EditorView;
  vimMode: VimMode;
  key: string;
  isStandardEditorShortcut: boolean;
  isVimCommand: boolean;
}

/**
 * Event priority levels (higher number = higher priority)
 */
export enum EventPriority {
  VIM_COMMAND = 1,
  APPLICATION_SHORTCUT = 2,
  STANDARD_EDITOR_SHORTCUT = 3,
  SYSTEM_SHORTCUT = 4
}

/**
 * Centralized event coordinator that handles event routing with proper priorities
 */
export class VimEventCoordinator {
  private stateManager: VimStateManager;

  // Standard editor shortcuts that should always work
  private readonly STANDARD_EDITOR_SHORTCUTS = new Set([
    'Control+a',  // Select all
    'Control+c',  // Copy
    'Control+v',  // Paste
    'Control+x',  // Cut
    'Control+z',  // Undo
    'Control+y',  // Redo
    'Control+f',  // Find
    'Control+h',  // Find and replace
    'Control+s',  // Save
    'Control+Shift+z', // Redo (alternative)
    'Meta+a',     // Select all (Mac)
    'Meta+c',     // Copy (Mac)
    'Meta+v',     // Paste (Mac)
    'Meta+x',     // Cut (Mac)
    'Meta+z',     // Undo (Mac)
    'Meta+Shift+z', // Redo (Mac)
    'Meta+f',     // Find (Mac)
    'Meta+h',     // Find and replace (Mac)
    'Meta+s'      // Save (Mac)
  ]);

  // Keys that should never leak into the document in normal mode
  private readonly BLOCKED_KEYS_IN_NORMAL_MODE = new Set([
    'Enter',
    'Space',
    'Backspace',
    'Delete',
    'Tab'
  ]);

  constructor() {
    this.stateManager = VimStateManager.getInstance();
  }

  /**
   * Main event routing method - handles all keyboard events
   */
  public handleKeyboardEvent(event: KeyboardEvent, view: EditorView): EventHandlingResult {
    const context = this.buildEventContext(event, view);

    // Get event priority
    const priority = this.getEventPriority(context);

    console.log(`[VimEventCoordinator] Handling ${context.key} (priority: ${priority}, mode: ${context.vimMode})`);

    // Route based on priority
    switch (priority) {
      case EventPriority.SYSTEM_SHORTCUT:
        return this.handleSystemShortcut(context);

      case EventPriority.STANDARD_EDITOR_SHORTCUT:
        return this.handleStandardEditorShortcut(context);

      case EventPriority.APPLICATION_SHORTCUT:
        return this.handleApplicationShortcut(context);

      case EventPriority.VIM_COMMAND:
        return this.handleVimCommand(context);

      default:
        // Unknown event - let it through if in insert mode, block otherwise
        return this.handleUnknownEvent(context);
    }
  }

  /**
   * Handle input events (character insertion)
   */
  public handleInputEvent(event: InputEvent, view: EditorView): EventHandlingResult {
    const vimMode = this.stateManager.getMode();

    // Allow input in insert/replace modes
    if (this.stateManager.isInInsertMode()) {
      return {
        handled: false,
        preventDefault: false,
        stopPropagation: false,
        allowDefault: true
      };
    }

    // Block all input in other modes
    console.log(`[VimEventCoordinator] Blocked input event in ${vimMode} mode:`, event.data);

    return {
      handled: true,
      preventDefault: true,
      stopPropagation: true,
      allowDefault: false
    };
  }

  /**
   * Build context object for event handling decisions
   */
  private buildEventContext(event: KeyboardEvent, view: EditorView): KeyEventContext {
    const vimMode = this.stateManager.getMode();
    const key = this.buildKeyString(event);

    return {
      event,
      view,
      vimMode,
      key,
      isStandardEditorShortcut: this.isStandardEditorShortcut(key),
      isVimCommand: this.isVimCommand(event, vimMode)
    };
  }

  /**
   * Build a consistent key string from keyboard event
   */
  private buildKeyString(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey || event.metaKey) {
      parts.push(event.ctrlKey ? 'Control' : 'Meta');
    }
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');

    parts.push(event.key);

    return parts.join('+');
  }

  /**
   * Determine event priority based on context
   */
  private getEventPriority(context: KeyEventContext): EventPriority {
    // System shortcuts (e.g., Alt+Tab) - highest priority
    if (this.isSystemShortcut(context.key)) {
      return EventPriority.SYSTEM_SHORTCUT;
    }

    // Standard editor shortcuts - high priority
    if (context.isStandardEditorShortcut) {
      return EventPriority.STANDARD_EDITOR_SHORTCUT;
    }

    // Application-specific shortcuts - medium priority
    if (this.isApplicationShortcut(context.key)) {
      return EventPriority.APPLICATION_SHORTCUT;
    }

    // Vim commands - lowest priority
    if (context.isVimCommand) {
      return EventPriority.VIM_COMMAND;
    }

    return EventPriority.VIM_COMMAND; // Default to vim handling
  }

  /**
   * Check if this is a standard editor shortcut
   */
  private isStandardEditorShortcut(key: string): boolean {
    return this.STANDARD_EDITOR_SHORTCUTS.has(key);
  }

  /**
   * Check if this is a system shortcut that should always pass through
   */
  private isSystemShortcut(key: string): boolean {
    // Alt+Tab, Cmd+Tab, etc.
    return key.includes('Alt+Tab') || key.includes('Meta+Tab');
  }

  /**
   * Check if this is an application shortcut
   */
  private isApplicationShortcut(key: string): boolean {
    // Application-specific shortcuts would go here
    // For now, we don't have any
    return false;
  }

  /**
   * Check if this could be a vim command
   */
  private isVimCommand(event: KeyboardEvent, vimMode: VimMode): boolean {
    // In insert mode, most keys are regular input, not vim commands
    if (vimMode === 'insert' || vimMode === 'replace') {
      // Only Escape and a few other keys are vim commands in insert mode
      return event.key === 'Escape' || (event.ctrlKey && (['[', 'c'].indexOf(event.key) !== -1));
    }

    // In normal/visual mode, most single keys are vim commands
    // But not if they have ctrl/meta modifiers (those are editor shortcuts)
    if (event.ctrlKey || event.metaKey) {
      return false;
    }

    // Single characters in normal/visual mode are typically vim commands
    return event.key.length === 1 || (['Escape', 'Enter', 'Backspace', 'Delete'].indexOf(event.key) !== -1);
  }

  /**
   * Handle system shortcuts (pass through)
   */
  private handleSystemShortcut(context: KeyEventContext): EventHandlingResult {
    console.log(`[VimEventCoordinator] Passing through system shortcut: ${context.key}`);

    return {
      handled: false,
      preventDefault: false,
      stopPropagation: false,
      allowDefault: true
    };
  }

  /**
   * Handle standard editor shortcuts (always allow)
   */
  private handleStandardEditorShortcut(context: KeyEventContext): EventHandlingResult {
    console.log(`[VimEventCoordinator] Handling standard editor shortcut: ${context.key} (mode: ${context.vimMode})`);

    // Standard shortcuts should work regardless of vim mode
    // But we need to ensure vim state remains consistent afterwards

    // Special handling for paste operations in normal mode
    if ((context.key === 'Control+v' || context.key === 'Meta+v') && context.vimMode === 'normal') {
      // Temporarily switch to insert mode for paste operation
      console.log('[VimEventCoordinator] Temporarily enabling insert mode for paste');
      // Note: The actual paste handling and mode restoration would be handled
      // by the application layer, we just allow it through here
    }

    return {
      handled: false, // Let the editor handle it
      preventDefault: false,
      stopPropagation: false,
      allowDefault: true
    };
  }

  /**
   * Handle application shortcuts
   */
  private handleApplicationShortcut(context: KeyEventContext): EventHandlingResult {
    console.log(`[VimEventCoordinator] Handling application shortcut: ${context.key}`);

    // Application shortcuts would be handled here
    return {
      handled: false,
      preventDefault: false,
      stopPropagation: false,
      allowDefault: true
    };
  }

  /**
   * Handle vim commands
   */
  private handleVimCommand(context: KeyEventContext): EventHandlingResult {
    const { event, vimMode, key } = context;

    // In normal mode, block certain keys from leaking
    if (vimMode === 'normal' && this.shouldBlockKeyInNormalMode(event)) {
      console.log(`[VimEventCoordinator] Blocking key in normal mode: ${key}`);

      return {
        handled: true,
        preventDefault: true,
        stopPropagation: true,
        allowDefault: false
      };
    }

    // In insert mode, only handle vim-specific commands (Escape, Ctrl+C, etc.)
    if (this.stateManager.isInInsertMode() && !this.isVimCommandInInsertMode(event)) {
      // Regular character input in insert mode
      return {
        handled: false,
        preventDefault: false,
        stopPropagation: false,
        allowDefault: true
      };
    }

    // Let vim handle the command
    console.log(`[VimEventCoordinator] Passing to vim: ${key} (mode: ${vimMode})`);

    return {
      handled: false, // Vim plugin will handle it
      preventDefault: false, // Vim plugin will decide
      stopPropagation: false,
      allowDefault: false // Vim plugin controls this
    };
  }

  /**
   * Handle unknown events (fallback)
   */
  private handleUnknownEvent(context: KeyEventContext): EventHandlingResult {
    const { vimMode, key } = context;

    if (this.stateManager.isInInsertMode()) {
      // Allow unknown events in insert mode (probably regular typing)
      return {
        handled: false,
        preventDefault: false,
        stopPropagation: false,
        allowDefault: true
      };
    } else {
      // Block unknown events in normal mode to prevent character leaking
      console.log(`[VimEventCoordinator] Blocking unknown event in ${vimMode} mode: ${key}`);

      return {
        handled: true,
        preventDefault: true,
        stopPropagation: true,
        allowDefault: false
      };
    }
  }

  /**
   * Check if a key should be blocked in normal mode
   */
  private shouldBlockKeyInNormalMode(event: KeyboardEvent): boolean {
    // Block keys that would insert characters
    if (this.BLOCKED_KEYS_IN_NORMAL_MODE.has(event.key)) {
      return true;
    }

    // Block single characters that aren't vim commands
    if (event.key.length === 1 && !this.isKnownVimKey(event.key)) {
      return true;
    }

    return false;
  }

  /**
   * Check if this is a vim command that should be handled in insert mode
   */
  private isVimCommandInInsertMode(event: KeyboardEvent): boolean {
    // Escape always exits insert mode
    if (event.key === 'Escape') return true;

    // Ctrl+C also exits insert mode
    if (event.ctrlKey && event.key === 'c') return true;

    // Ctrl+[ also exits insert mode
    if (event.ctrlKey && event.key === '[') return true;

    return false;
  }

  /**
   * Check if this is a known vim key (rough heuristic)
   */
  private isKnownVimKey(key: string): boolean {
    // Common vim movement and command keys
    const vimKeys = new Set([
      'h', 'j', 'k', 'l', 'w', 'b', 'e', 'gg', 'G',
      'i', 'a', 'o', 'O', 'x', 'd', 'y', 'p', 'P',
      'u', 'r', 'c', 'v', 'V', 's', 'S', '/', '?',
      'n', 'N', ':', 'z', 'm', "'", '`', 'f', 'F',
      't', 'T', ';', ',', '$', '^', '0', '{', '}',
      '(', ')', '[', ']', '<', '>', '=', '~'
    ]);

    return vimKeys.has(key);
  }

  /**
   * Get debug information
   */
  public getDebugInfo(): object {
    return {
      standardEditorShortcuts: Array.from(this.STANDARD_EDITOR_SHORTCUTS),
      blockedKeysInNormalMode: Array.from(this.BLOCKED_KEYS_IN_NORMAL_MODE),
      currentVimMode: this.stateManager.getMode()
    };
  }
}