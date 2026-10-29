import { toast } from "@/stores/toast-store";
import { useEmailStore, type EmailRestoreBatch, type CrossAccountMoveReceipt } from "@/stores/email-store";
import type { ToastAction } from "@/components/ui/toast";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { linkUndoToast, recordUndo, runUndo } from "@/lib/undo-history";
import { formatShortcutCombo } from "@/lib/shortcut-keys";

/** How long a toast with Undo stays, so there is time to reach the button. */
export const UNDO_TOAST_DURATION = 8000;

/** The words the Undo action needs, from the `notifications` namespace. */
export interface UndoLabels {
  undo: string;
  done: string;
  failed: string;
  /** "Press Ctrl+Z to undo.", read out after the toast. */
  hint?: string;
}

/** An Undo for a toast, with the words a screen reader hears about it. */
export interface UndoToastAction extends ToastAction {
  hint?: string;
}

/** The undo shortcut as this platform writes it (Ctrl+Z, ⌘Z). */
export function undoShortcutLabel(): string {
  return formatShortcutCombo("Mod+Z");
}

/** `t` of the `notifications` namespace → UndoLabels. */
export function undoLabels(t: (key: string, values?: Record<string, string>) => string): UndoLabels {
  return {
    undo: t("undo"),
    done: t("undo_done"),
    failed: t("undo_failed"),
    hint: t("undo_hint", { keys: undoShortcutLabel() }),
  };
}

/**
 * The toast's Undo for a reversible move (delete to Trash, archive, move,
 * report spam, remove from folder): puts the messages back where `batches`
 * says they were. None when there is nothing to put back.
 *
 * `receipts` (filled while the move runs) name the messages it took to
 * another account: Undo moves those back, the same way, into the folders
 * their restore points name (undoMove).
 */
export function undoMoveAction(
  client: IJMAPClient | null | undefined,
  batches: EmailRestoreBatch[] | null | undefined,
  labels: UndoLabels,
  receipts?: CrossAccountMoveReceipt[],
): UndoToastAction | undefined {
  if (!client || !batches || !batches.some(b => b.points.length > 0)) return undefined;
  return {
    label: labels.undo,
    hint: labels.hint,
    onClick: () => {
      void (async () => {
        try {
          await useEmailStore.getState().undoMove(client, batches, receipts ?? []);
          toast.success(labels.done);
        } catch (error) {
          console.error("Failed to undo:", error);
          toast.error(labels.failed);
        }
      })();
    },
  };
}

/**
 * A success toast, with Undo when the action can be undone. The Undo also
 * goes into the undo history (lib/undo-history), so Ctrl+Z reaches it after
 * the toast is gone or another one took its place.
 */
export function toastWithUndo(title: string, undo: UndoToastAction | undefined, message?: string): void {
  if (!undo) {
    toast.success(title, message);
    return;
  }
  const entry = recordUndo(title, undo.onClick);
  const toastId = toast.success(title, {
    message,
    // The toast closes itself after its action ran.
    action: { label: undo.label, onClick: () => { runUndo(entry.id); } },
    duration: UNDO_TOAST_DURATION,
    srHint: undo.hint,
  });
  linkUndoToast(entry.id, toastId);
}

/**
 * Runs a bulk email-store action and toasts the outcome: a failure always, a
 * success when there is a message for it. Most batch actions report failure
 * through `state.error` instead of throwing (batchArchive does both), so a
 * resolved promise alone does not mean the mail moved. An action that
 * resolves `false` did nothing: a plugin vetoed it (and told the user why) or
 * there was nothing to act on, so there is no success to report. `undo` goes
 * on the success toast only: after a partial failure the list is reloaded and
 * the error says what stayed.
 */
export async function runBatchEmailAction(
  run: () => Promise<boolean | void>,
  messages: { success?: string; error: string; describeError?: (error: unknown) => string | undefined; undo?: ToastAction },
): Promise<void> {
  // An error left over from an earlier action is not this action's outcome.
  useEmailStore.setState({ error: null });
  let ran: boolean | void;
  try {
    ran = await run();
  } catch (error) {
    console.error(messages.error, error);
    const detail = messages.describeError?.(error) ?? (error instanceof Error ? error.message : undefined);
    toast.error(messages.error, detail);
    return;
  }
  const storeError = useEmailStore.getState().error;
  if (storeError) {
    toast.error(messages.error, storeError);
  } else if (ran !== false && messages.success) {
    toastWithUndo(messages.success, messages.undo);
  }
}
