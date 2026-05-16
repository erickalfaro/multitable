import { useState } from 'react';
import { Modal, Button } from '../../ui';

interface Props {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  extraToggle?: { label: string; initial?: boolean };
  onConfirm: (extra: boolean) => void;
  onCancel: () => void;
}

export function GitConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  destructive,
  extraToggle,
  onConfirm,
  onCancel,
}: Props) {
  const [extra, setExtra] = useState(extraToggle?.initial ?? false);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="sm"
            onClick={() => onConfirm(extra)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>{body}</div>
      {extraToggle && (
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 12,
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={extra}
            onChange={(e) => setExtra(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          {extraToggle.label}
        </label>
      )}
    </Modal>
  );
}
