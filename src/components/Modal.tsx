import { useState, useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  /** Whether clicking the backdrop closes the modal. Default: true */
  closeOnBackdrop?: boolean;
  /** Whether pressing Escape closes the modal. Default: true */
  closeOnEsc?: boolean;
  /** Additional class name for the modal content wrapper. */
  className?: string;
  /** Width of the modal content. Default: "auto" */
  width?: number | string;
}

/**
 * Generic modal component shared across all windows.
 *
 * Handles the common boilerplate:
 *   - Backdrop overlay with click-outside-to-close
 *   - Escape key to close
 *   - Stop propagation on content clicks
 *   - Conditional rendering (null when closed)
 *
 * Usage:
 *   <Modal open={show} onClose={() => setShow(false)}>
 *     <h3>My dialog</h3>
 *     <p>Content here</p>
 *   </Modal>
 */
export function Modal({
  open,
  onClose,
  children,
  closeOnBackdrop = true,
  closeOnEsc = true,
  className = "",
  width,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !closeOnEsc || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const contentStyle: React.CSSProperties = width
    ? { width: typeof width === "number" ? `${width}px` : width }
    : {};

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div
        ref={contentRef}
        className={`modal-content ${className}`}
        style={contentStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
  icon?: ReactNode;
}

/**
 * Reusable confirmation dialog (OK / Cancel style).
 *
 * Replaces the 5+ inline confirm dialogs in the app (clear-history,
 * delete-note, delete-category, exec-file, etc.) with a single component.
 * Matches the existing `exec-confirm-dialog` CSS so no style changes needed.
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  confirmClass = "exec-btn-open",
  onConfirm,
  onCancel,
  icon,
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onCancel} className="exec-confirm-dialog">
      {icon && <div className="exec-confirm-icon">{icon}</div>}
      <h3 className="exec-confirm-title">{title}</h3>
      {typeof message === "string" ? (
        <p className="exec-confirm-desc">{message}</p>
      ) : (
        <div className="exec-confirm-desc">{message}</div>
      )}
      <div className="exec-confirm-buttons">
        <button className="exec-btn-cancel" onClick={onCancel}>
          {cancelText}
        </button>
        <button className={confirmClass} onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

interface PromptModalProps {
  open: boolean;
  title: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  /** Optional validation: return error message, or null/empty if valid */
  validate?: (value: string) => string | null;
}

/**
 * Reusable text-input prompt dialog.
 *
 * Replaces the inline PromptModal in NotesApp and any future askText
 * call sites. Supports validation and auto-focus.
 */
export function PromptModal({
  open,
  title,
  defaultValue = "",
  placeholder = "请输入…",
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
  validate,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset value when opening
  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setError(null);
      // Auto-focus on next tick so the input is ready
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, defaultValue]);

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    onConfirm(trimmed);
  };

  return (
    <Modal open={open} onClose={onCancel} className="exec-confirm-dialog">
      <h3 className="exec-confirm-title">{title}</h3>
      <input
        ref={inputRef}
        className={`settings-input ${error ? "input-error" : ""}`}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleConfirm();
        }}
      />
      {error && <p className="tools-error" style={{ marginTop: "8px" }}>{error}</p>}
      <div className="exec-confirm-buttons">
        <button className="exec-btn-cancel" onClick={onCancel}>
          {cancelText}
        </button>
        <button className="exec-btn-open" onClick={handleConfirm}>
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}
