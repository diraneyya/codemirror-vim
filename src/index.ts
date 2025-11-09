import { initVim } from "./vim";
import { CodeMirror } from "./cm_adapter";
import { BlockCursorPlugin, hideNativeSelection } from "./block-cursor";
import { VimStateManager, type VimMode } from "./vim-state-manager";
import { VimEventCoordinator } from "./vim-event-coordinator";
import {
  Extension,
  StateField,
  StateEffect,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  ViewPlugin,
  PluginValue,
  ViewUpdate,
  Decoration,
  EditorView,
  showPanel,
  Panel,
} from "@codemirror/view";
import { setSearchQuery } from "@codemirror/search";

var FIREFOX_LINUX = typeof navigator != "undefined"
  && /linux/i.test(navigator.platform)
  && / Gecko\/\d+/.exec(navigator.userAgent);

const Vim = initVim(CodeMirror);

const HighlightMargin = 250;

const vimStyle = EditorView.baseTheme({
  ".cm-vimMode .cm-cursorLayer:not(.cm-vimCursorLayer)": {
    display: "none",
  },
  ".cm-vim-panel": {
    padding: "0px 10px",
    fontFamily: "monospace",
    minHeight: "1.3em",
    display: 'flex',
  },
  ".cm-vim-panel input": {
    border: "none",
    outline: "none",
    backgroundColor: "inherit",
  },

  "&light .cm-searchMatch": { backgroundColor: "#ffff0054" },
  "&dark .cm-searchMatch": { backgroundColor: "#00ffff8a" },
});
type EditorViewExtended = EditorView & { cm: CodeMirror };

const vimPlugin = ViewPlugin.fromClass(
  class implements PluginValue {
    private dom: HTMLElement;
    private statusButton: HTMLElement;
    private spacer: HTMLElement;
    public view: EditorViewExtended;
    public cm: CodeMirror;
    public status = "";
    blockCursor: BlockCursorPlugin;
    private stateManager: VimStateManager;
    private eventCoordinator: VimEventCoordinator;
    private viewId: string;
    constructor(view: EditorView) {
      this.view = view as EditorViewExtended;
      const cm = (this.cm = new CodeMirror(view));
      Vim.enterVimMode(this.cm);

      this.view.cm = this.cm;
      this.cm.state.vimPlugin = this;

      // Initialize robust state management
      this.stateManager = VimStateManager.getInstance();
      this.eventCoordinator = new VimEventCoordinator();
      this.viewId = `vim-view-${Date.now()}-${Math.random()}`;

      // Register with state manager
      this.stateManager.registerEditor(this.viewId, view, cm);

      this.blockCursor = new BlockCursorPlugin(view, cm);
      this.updateClass();

      console.log(`[VimPlugin] Initialized robust vim plugin for ${this.viewId}`);

      this.cm.on("vim-command-done", () => {
        if (cm.state.vim) cm.state.vim.status = "";
        this.blockCursor.scheduleRedraw();
        this.updateStatus();
      });
      this.cm.on("vim-mode-change", (e: any) => {
        if (!cm.state.vim) return;

        // Update through robust state manager instead of direct assignment
        const newMode = e.mode as VimMode;
        const newSubMode = e.subMode === "linewise" ? "linewise" : (e.subMode === "blockwise" ? "blockwise" : null);

        console.log(`[VimPlugin] Mode change event: ${newMode}${newSubMode ? ` (${newSubMode})` : ''}`);

        // Use state manager for consistent state updates
        this.stateManager.transitionTo(newMode, newSubMode, 'plugin');

        cm.state.vim.status = "";
        this.blockCursor.scheduleRedraw();
        this.updateClass();
        this.updateStatus();
      });

      this.cm.on("dialog", () => {
        if (this.cm.state.statusbar) {
          this.updateStatus();
        } else {
          view.dispatch({
            effects: showVimPanel.of(!!this.cm.state.dialog),
          });
        }
      });

      this.dom = document.createElement("span");
      this.spacer = document.createElement("span");
      this.spacer.style.flex = "1";
      this.statusButton = document.createElement("span");
      this.statusButton.onclick = (e) => {
        Vim.handleKey(this.cm, "<Esc>", "user");
        this.cm.focus();
      };
      this.statusButton.style.cssText = "cursor: pointer";
    }

    update(update: ViewUpdate) {
      if ((update.viewportChanged || update.docChanged) && this.query) {
        this.highlight(this.query);
      }
      if (update.docChanged) {
        this.cm.onChange(update);
      }
      if (update.selectionSet) {
        this.cm.onSelectionChange();
      }
      if (update.viewportChanged) {
        // scroll
      }
      if (this.cm.curOp && !this.cm.curOp.isVimOp) {
        this.cm.onBeforeEndOperation();
      }
      if (update.transactions) {
        for (let tr of update.transactions)
          for (let effect of tr.effects) {
            if (effect.is(setSearchQuery)) {
              let forVim = (effect.value as any)?.forVim;
              if (!forVim) {
                this.highlight(null);
              } else {
                let query = (effect.value as any).create();
                this.highlight(query);
              }
            }
          }
      }

      this.blockCursor.update(update);
    }
    updateClass() {
      const state = this.cm.state;

      // Use state manager for consistent class updates
      if (this.stateManager.isInInsertMode() && !state.overwrite) {
        this.view.scrollDOM.classList.remove("cm-vimMode");
      } else {
        this.view.scrollDOM.classList.add("cm-vimMode");
      }

      // Sync contentEditable based on state manager
      if (this.stateManager.shouldBlockInput()) {
        this.view.contentDOM.setAttribute('contenteditable', 'false');
      } else {
        this.view.contentDOM.setAttribute('contenteditable', 'true');
      }
    }
    updateStatus() {
      let dom = this.cm.state.statusbar;
      let vim = this.cm.state.vim;
      if (!dom || !vim) return;
      let dialog = this.cm.state.dialog;
      if (dialog) {
        if (dialog.parentElement != dom) {
          dom.textContent = "";
          dom.appendChild(dialog);
        }
      } else {
        dom.textContent = ""
        var status = (vim.mode || "normal").toUpperCase();
        if (vim.insertModeReturn) status += "(C-O)"
        this.statusButton.textContent = `--${status}--`;
        dom.appendChild(this.statusButton);
        dom.appendChild(this.spacer);
      }

      this.dom.textContent = vim.status;
      dom.appendChild(this.dom);
    }

    destroy() {
      // Unregister from state manager
      this.stateManager.unregisterEditor(this.viewId);

      Vim.leaveVimMode(this.cm);
      this.updateClass();
      this.blockCursor.destroy();
      delete (this.view as any).cm;

      console.log(`[VimPlugin] Destroyed robust vim plugin for ${this.viewId}`);
    }

    highlight(query: any) {
      this.query = query;
      if (!query) return (this.decorations = Decoration.none);
      let { view } = this;
      let builder = new RangeSetBuilder<Decoration>();
      for (
        let i = 0, ranges = view.visibleRanges, l = ranges.length;
        i < l;
        i++
      ) {
        let { from, to } = ranges[i];
        while (i < l - 1 && to > ranges[i + 1].from - 2 * HighlightMargin)
          to = ranges[++i].to;
        query.highlight(
          view.state,
          from,
          to,
          (from: number, to: number) => {
            builder.add(from, to, matchMark);
          }
        );
      }
      return (this.decorations = builder.finish());
    }
    query = null;
    decorations = Decoration.none;
    waitForCopy = false;
    handleKey(e: KeyboardEvent, view: EditorView) {
      const cm = this.cm;
      let vim = cm.state.vim;
      if (!vim) return;

      // Use robust event coordinator for event handling
      const eventResult = this.eventCoordinator.handleKeyboardEvent(e, view);

      // If coordinator handled it, respect its decision
      if (eventResult.handled) {
        if (eventResult.preventDefault) e.preventDefault();
        if (eventResult.stopPropagation) e.stopPropagation();
        return eventResult.allowDefault;
      }

      // If coordinator says to allow default, don't process as vim command
      if (eventResult.allowDefault && !eventResult.handled) {
        return false; // Let default editor behavior handle it
      }

      const key = Vim.vimKeyFromEvent(e, vim);
      CodeMirror.signal(this.cm, 'inputEvent', {type: "handleKey", key});
      if (!key) return;

      // clear search highlight
      if (
        key == "<Esc>" &&
        !vim.insertMode &&
        !vim.visualMode &&
        this.query /* && !cm.inMultiSelectMode*/
      ) {
        const searchState = vim.searchState_
        if (searchState) {
          cm.removeOverlay(searchState.getOverlay())
          searchState.setOverlay(null);
        }
      }

      let isCopy = key === "<C-c>" && !CodeMirror.isMac;
      if (isCopy && cm.somethingSelected()) {
        this.waitForCopy = true;
        return true;
      }

      vim.status = (vim.status || "") + key;
      let result = Vim.multiSelectHandleKey(cm, key, "user");
      vim = Vim.maybeInitVimState_(cm); // the object can change if there is an exception in handleKey

      // insert mode
      if (!result && vim.insertMode && cm.state.overwrite) {
        if (e.key && e.key.length == 1 && !/\n/.test(e.key)) {
          result = true;
          cm.overWriteSelection(e.key);
        } else if (e.key == "Backspace") {
          result = true;
          CodeMirror.commands.cursorCharLeft(cm);
        }
      }
      if (result) {
        CodeMirror.signal(this.cm, 'vim-keypress', key);
        e.preventDefault();
        e.stopPropagation();
        this.blockCursor.scheduleRedraw();
      }

      this.updateStatus();

      return !!result;
    }
    lastKeydown = ''
    useNextTextInput = false
    compositionText = ''
  },
  {
    eventHandlers: {
      copy: function(e: ClipboardEvent, view: EditorView) {
        if (!this.waitForCopy) return;
        this.waitForCopy = false;
        Promise.resolve().then(() => {
          var cm = this.cm;
          var vim = cm.state.vim;
          if (!vim) return;
          if (vim.insertMode) {
            cm.setSelection(cm.getCursor(), cm.getCursor());
          } else {
            cm.operation(() => {
              if (cm.curOp) cm.curOp.isVimOp = true;
              Vim.handleKey(cm, '<Esc>', 'user');
            });
          }
        });
      },
      compositionstart: function(e: Event, view: EditorView) {
        this.useNextTextInput = true;
        CodeMirror.signal(this.cm, 'inputEvent', e);
      },
      compositionupdate: function(e: Event, view: EditorView) {
        CodeMirror.signal(this.cm, 'inputEvent', e);
      },
      compositionend: function(e: Event, view: EditorView) {
        CodeMirror.signal(this.cm, 'inputEvent', e);
      },
      keypress: function(e: KeyboardEvent, view: EditorView) {
        CodeMirror.signal(this.cm, 'inputEvent', e);
        if (this.lastKeydown == "Dead")
          this.handleKey(e, view);
      },
      keydown: function(e: KeyboardEvent, view: EditorView) {
        CodeMirror.signal(this.cm, 'inputEvent', e);
        this.lastKeydown = e.key;
        if (
          this.lastKeydown == "Unidentified"
          || this.lastKeydown == "Process"
          || this.lastKeydown == "Dead"
        ) {
          this.useNextTextInput = true;
        } else {
          this.useNextTextInput = false;
          this.handleKey(e, view);
        }
      },
    },
    provide: () => {
      return [
        EditorView.inputHandler.of((view, from, to, text) => {
          var cm = getCM(view);
          if (!cm) return false;
          var vim = cm.state?.vim;
          var vimPlugin = cm.state.vimPlugin;

          // Use robust event coordinator for input handling
          if (vimPlugin && vimPlugin.eventCoordinator) {
            const inputEvent = new InputEvent('input', { data: text });
            const result = vimPlugin.eventCoordinator.handleInputEvent(inputEvent, view);

            if (result.handled) {
              console.log(`[VimPlugin] Input blocked by coordinator: "${text}" (mode: ${vimPlugin.stateManager.getMode()})`);
              return true; // Block the input
            }

            // If coordinator says to allow, let it through
            if (result.allowDefault) {
              return false; // Allow normal input processing
            }
          }

          // Fallback to original logic if coordinator not available
          if (vim && !vim.insertMode && !cm.curOp?.isVimOp) {
            if (text === "\0\0") {
              return true;
            }
            CodeMirror.signal(cm, 'inputEvent', {
              type: "text",
              text,
              from,
              to,
            });
            if (text.length == 1 && vimPlugin && vimPlugin.useNextTextInput) {
              if (vim.expectLiteralNext && view.composing) {
                vimPlugin.compositionText = text;
                return false
              }
              if (vimPlugin.compositionText) {
                var toRemove = vimPlugin.compositionText;
                vimPlugin.compositionText = '';
                var head = view.state.selection.main.head
                var textInDoc = view.state.sliceDoc(head - toRemove.length, head);
                if (toRemove === textInDoc) {
                  var pos = cm.getCursor();
                  cm.replaceRange('', cm.posFromIndex(head - toRemove.length), pos);
                }
              }
              vimPlugin.handleKey({
                key: text,
                preventDefault: ()=>{},
                stopPropagation: ()=>{}
              });
              forceEndComposition(view);
              return true;
            }
          }
          return false;
        })
      ]
    },

    decorations: (v) => v.decorations,
  }
);

/**
 * removes contenteditable element and adds it back to end
 * IME composition in normal mode
 * this method works on all browsers except for Firefox on Linux
 * where we need to reset textContent of editor 
 * (which doesn't work on other browsers)
 */
function forceEndComposition(view: EditorView) {
  var parent = view.scrollDOM.parentElement;
  if (!parent) return;

  if (FIREFOX_LINUX) {
    view.contentDOM.textContent = "\0\0";
    view.contentDOM.dispatchEvent(new CustomEvent("compositionend"));
    return;
  }
  var sibling = view.scrollDOM.nextSibling;
  var selection = window.getSelection();
  var savedSelection = selection && {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset
  };

  view.scrollDOM.remove();
  parent.insertBefore(view.scrollDOM, sibling);
  try {
    if (savedSelection && selection) {
      selection.setPosition(savedSelection.anchorNode, savedSelection.anchorOffset);
      if (savedSelection.focusNode) {
        selection.extend(savedSelection.focusNode, savedSelection.focusOffset);
      }
    }
  } catch(e) {
    console.error(e);
  }
  view.focus();
  view.contentDOM.dispatchEvent(new CustomEvent("compositionend"));
}

const matchMark = Decoration.mark({ class: "cm-searchMatch" });

const showVimPanel = StateEffect.define<boolean>();

const vimPanelState = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (let e of tr.effects) if (e.is(showVimPanel)) value = e.value;
    return value;
  },
  provide: (f) => {
    return showPanel.from(f, (on) => (on ? createVimPanel : null));
  },
});

function createVimPanel(view: EditorView) {
  let dom = document.createElement("div");
  dom.className = "cm-vim-panel";
  let cm = (view as EditorViewExtended).cm;
  if (cm.state.dialog) {
    dom.appendChild(cm.state.dialog);
  }
  return { top: false, dom };
}

function statusPanel(view: EditorView): Panel {
  let dom = document.createElement("div");
  dom.className = "cm-vim-panel";
  let cm = (view as EditorViewExtended).cm;
  cm.state.statusbar = dom;
  cm.state.vimPlugin.updateStatus();
  return { dom };
}

export function vim(options: { status?: boolean } = {}): Extension {
  return [
    vimStyle,
    vimPlugin,
    hideNativeSelection,
    options.status ? showPanel.of(statusPanel) : vimPanelState,
  ];
}

export { CodeMirror, Vim, VimStateManager, VimEventCoordinator };

export function getCM(view: EditorView): CodeMirror | null {
  return (view as EditorViewExtended).cm || null;
}

