"use client";

import { useEffect, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { UploadCloud, X } from "lucide-react";

type Tone = "default" | "success" | "warning" | "danger" | "accent";

const TONE_COLOR: Record<Tone, string> = {
  default: "#38bdf8",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  accent: "#818cf8"
};

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  progress,
  loading,
  onClick
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  tone?: Tone;
  /** 0–100, renders a thin progress bar */
  progress?: number;
  loading?: boolean;
  onClick?: () => void;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div
      className={`noema-card${onClick ? " interactive" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>{label}</span>
        {icon && (
          <span
            style={{
              color,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 9,
              background: `${color}1a`,
              border: `1px solid ${color}33`
            }}
          >
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton height={28} width="55%" />
      ) : (
        <div style={{ fontSize: 26, fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </div>
      )}
      {typeof progress === "number" && (
        <div className="noema-progress">
          <span style={{ width: `${Math.max(0, Math.min(100, progress))}%`, background: color }} />
        </div>
      )}
      {hint && <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  dot?: boolean;
}) {
  const styles: Record<typeof tone, { bg: string; color: string; border: string }> = {
    neutral: { bg: "rgba(148,163,184,0.1)", color: "#cbd5e1", border: "rgba(148,163,184,0.18)" },
    success: { bg: "rgba(16,185,129,0.12)", color: "#34d399", border: "rgba(16,185,129,0.28)" },
    warning: { bg: "rgba(245,158,11,0.12)", color: "#fbbf24", border: "rgba(245,158,11,0.28)" },
    danger: { bg: "rgba(239,68,68,0.12)", color: "#f87171", border: "rgba(239,68,68,0.28)" },
    accent: { bg: "rgba(99,102,241,0.14)", color: "#a5b4fc", border: "rgba(99,102,241,0.32)" }
  };
  const s = styles[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 550,
        lineHeight: 1.5,
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        whiteSpace: "nowrap"
      }}
    >
      {dot && <span className="noema-dot" style={{ background: s.color, width: 6, height: 6 }} />}
      {children}
    </span>
  );
}

/** Maps a free-form status string to a badge tone. */
export function statusTone(status?: string): "neutral" | "success" | "warning" | "danger" | "accent" {
  const s = (status ?? "").toLowerCase();
  if (["approved", "completed", "succeeded", "success", "passed", "active", "connected", "done"].includes(s)) return "success";
  if (["draft", "pending", "queued", "running", "created", "retry", "in_progress", "open", "changes_requested"].includes(s)) return "warning";
  if (["rejected", "failed", "error", "cancelled", "expired", "deprecated"].includes(s)) return "danger";
  if (["superseded"].includes(s)) return "neutral";
  return "accent";
}

export function PageHeader({
  title,
  description,
  icon,
  actions
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="noema-page-header">
      <div style={{ minWidth: 0 }}>
        <h1 className="noema-page-title">
          {icon && <span className="noema-page-title-icon">{icon}</span>}
          {title}
        </h1>
        {description && <p className="noema-page-desc" style={{ marginBottom: 0 }}>{description}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{actions}</div>}
    </div>
  );
}

export function SectionCard({
  title,
  subtitle,
  icon,
  actions,
  children,
  flush,
  style
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Remove body padding (for lists/tables that touch the card edge) */
  flush?: boolean;
  style?: CSSProperties;
}) {
  const hasHeader = Boolean(title || actions);
  return (
    <section className={`noema-card ${flush ? "noema-card-flush" : ""}`} style={style}>
      {hasHeader && (
        <div
          className="noema-card-header"
          style={flush ? { padding: "14px 16px", marginBottom: 0, borderBottom: "1px solid var(--border-subtle)" } : undefined}
        >
          <div style={{ minWidth: 0 }}>
            {title && (
              <div className="noema-card-title">
                {icon && <span style={{ display: "inline-flex", color: "#a5b4fc" }}>{icon}</span>}
                {title}
              </div>
            )}
            {subtitle && <div className="noema-card-subtitle">{subtitle}</div>}
          </div>
          {actions && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="noema-empty">
      {icon && <div className="noema-empty-icon">{icon}</div>}
      <div className="noema-empty-title">{title}</div>
      {description && <div className="noema-empty-desc">{description}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ height = 14, width = "100%", radius }: { height?: number; width?: number | string; radius?: number }) {
  return <div className="noema-skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 4 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Skeleton height={32} width={32} radius={9} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <Skeleton height={12} width={`${60 - i * 7}%`} />
            <Skeleton height={10} width={`${35 + i * 5}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ id: T; label: ReactNode; count?: number; icon?: ReactNode }>;
  ariaLabel?: string;
}) {
  return (
    <div className="noema-segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={value === opt.id ? "active" : ""}
          onClick={() => onChange(opt.id)}
        >
          {opt.icon}
          {opt.label}
          {typeof opt.count === "number" && <span className="count">{opt.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="noema-field">
      {label}
      {children}
      {hint && <span className="noema-field-hint">{hint}</span>}
    </label>
  );
}

export function SlideOverDrawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="noema-drawer-overlay" onClick={onClose}>
      <div className="noema-drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="noema-drawer-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, wordBreak: "break-word" }}>{title}</h3>
            {subtitle && (
              <div className="noema-mono" style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 5, wordBreak: "break-all" }}>
                {subtitle}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="noema-kbd noema-hide-mobile">Esc</span>
            <button className="noema-btn noema-btn-ghost noema-btn-icon" onClick={onClose} aria-label="Fechar painel">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="noema-drawer-body">{children}</div>
        {footer && (
          <div style={{ padding: "12px 22px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function DropzoneCard({
  label,
  accept,
  onFileSelected,
  hint
}: {
  label: string;
  accept: string;
  onFileSelected: (file: File) => void;
  hint?: string;
}) {
  const handleDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.4)";
    const file = e.dataTransfer.files?.[0];
    if (file) onFileSelected(file);
  };
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        e.currentTarget.style.borderColor = "rgba(129, 140, 248, 0.9)";
      }}
      onDragLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.4)";
      }}
      onDrop={handleDrop}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "16px 18px",
        borderRadius: 14,
        border: "1px dashed rgba(99, 102, 241, 0.4)",
        background: "rgba(99, 102, 241, 0.04)",
        cursor: "pointer",
        transition: "border-color 0.15s ease"
      }}
    >
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(99, 102, 241, 0.14)",
          color: "#a5b4fc"
        }}
      >
        <UploadCloud size={19} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 550, color: "var(--text-primary)" }}>{label}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {hint ?? "Arraste e solte aqui ou clique para selecionar"}
        </span>
      </span>
      <input
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelected(file);
          e.target.value = "";
        }}
      />
    </label>
  );
}
