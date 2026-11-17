"use client";

import { Command } from "cmdk";
import { useEffect, type ReactNode } from "react";
import { FolderPlus, Search } from "lucide-react";

export function CommandPalette({
  open,
  onOpenChange,
  workspaces,
  projects,
  onSelectWorkspace,
  onSelectProject,
  onOpenNewProject
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: ReadonlyArray<{ id: string; label: string; icon?: ReactNode }>;
  projects: Array<{ projectId: string; name: string }>;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (projectId: string) => void;
  onOpenNewProject: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Navegação rápida Noema">
      <div style={{ display: "flex", alignItems: "center", paddingLeft: 14, borderBottom: "1px solid rgba(148,163,184,0.14)" }}>
        <Search size={15} color="#64748b" />
        <Command.Input placeholder="Ir para workspace, trocar projeto ou criar novo..." style={{ borderBottom: "none" }} />
      </div>
      <Command.List>
        <Command.Empty>Nenhum resultado encontrado.</Command.Empty>
        <Command.Group heading="Ações rápidas">
          <Command.Item
            onSelect={() => {
              onOpenNewProject();
              onOpenChange(false);
            }}
          >
            <FolderPlus size={14} color="#818cf8" />
            <span>Cadastrar novo projeto</span>
          </Command.Item>
        </Command.Group>
        <Command.Group heading="Workspaces">
          {workspaces.map((ws) => (
            <Command.Item
              key={ws.id}
              onSelect={() => {
                onSelectWorkspace(ws.id);
                onOpenChange(false);
              }}
            >
              {ws.icon}
              <span>{ws.label}</span>
            </Command.Item>
          ))}
        </Command.Group>
        {projects.length > 0 && (
          <Command.Group heading="Projetos cadastrados">
            {projects.map((p) => (
              <Command.Item
                key={p.projectId}
                onSelect={() => {
                  onSelectProject(p.projectId);
                  onOpenChange(false);
                }}
              >
                <span style={{ fontFamily: "monospace", color: "#38bdf8" }}>{p.projectId}</span>
                <span style={{ color: "#94a3b8" }}>— {p.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

