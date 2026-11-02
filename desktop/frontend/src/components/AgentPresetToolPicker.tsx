import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { app } from "../lib/bridge";
import { agentPresetTools } from "../lib/agentPresets";
import { useT } from "../lib/i18n";
import { AnchoredPopover } from "./AnchoredPopover";

if (import.meta.env?.MODE) void import("./SettingsSelect.css");

type ToolGroup = "builtin" | "mcp" | "custom";
type ToolOption = { value: string; group: ToolGroup; hint?: string; add?: boolean };

/** Multi-select over the built-in tools and MCP servers, plus free-form names or patterns. */
export function AgentPresetToolPicker({ id, value, disabled, onChange }: {
  id: string;
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [known, setKnown] = useState<{ builtin: ToolOption[]; mcp: ToolOption[] }>({ builtin: [], mcp: [] });
  useEffect(() => {
    let alive = true;
    // A failed catalog only removes suggestions; typed names still work.
    void Promise.all([app.AvailableSubagentTools().catch(() => []), app.MCPServers().catch(() => [])]).then(([tools, servers]) => {
      if (!alive) return;
      setKnown({
        builtin: (tools ?? []).map(tool => ({ value: tool.name, group: "builtin", hint: tool.description })),
        mcp: (servers ?? []).map(server => ({ value: `mcp:${server.name}`, group: "mcp" })),
      });
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const selected = useMemo(() => new Set(value), [value]);
  const options = useMemo(() => {
    const listed = new Set([...known.builtin, ...known.mcp].map(option => option.value));
    const custom: ToolOption[] = value.filter(name => !listed.has(name)).map(name => ({ value: name, group: "custom" }));
    const q = query.trim().toLocaleLowerCase();
    const visible = [...known.builtin, ...known.mcp, ...custom]
      .filter(option => !q || `${option.value} ${option.hint ?? ""}`.toLocaleLowerCase().includes(q));
    const typed = agentPresetTools(query)[0];
    if (typed && !listed.has(typed) && !selected.has(typed)) visible.push({ value: typed, group: "custom", add: true });
    return visible;
  }, [known, value, query, selected]);
  const activeValue = options.some(option => option.value === active) ? active : options[0]?.value ?? null;
  const activeIndex = options.findIndex(option => option.value === activeValue);
  const toggle = (name: string) => onChange(selected.has(name) ? value.filter(item => item !== name) : [...value, name]);
  const pick = (option: ToolOption) => {
    toggle(option.value);
    if (option.add) setQuery("");
  };
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      const next = options[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length];
      setActive(next.value);
      document.getElementById(`${listId}-option-${options.indexOf(next)}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) pick(option);
    }
  };
  const groupLabel = (group: ToolGroup) => t(`agentPresets.toolGroup.${group}`);

  return <div className="agent-preset-tools">
    {!!value.length && <ul className="agent-preset-tools__chips" aria-label={t("agentPresets.toolList")}>
      {value.map(name => <li key={name} className="agent-preset-tools__chip">
        <code>{name}</code>
        <button type="button" disabled={disabled} aria-label={t("agentPresets.removeTool", { name })} onClick={() => toggle(name)}><X size={12} aria-hidden="true" /></button>
      </li>)}
    </ul>}
    <button ref={triggerRef} id={id} type="button" className="settings-select" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open && !disabled} onClick={() => { setQuery(""); setActive(null); setOpen(!open); }}>
      <span className="settings-select__value">{t("agentPresets.chooseTools", { n: value.length })}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    <AnchoredPopover open={open && !disabled} anchorRef={triggerRef} onClose={() => setOpen(false)}
      className="settings-select-menu agent-preset-tools__menu" placement="bottom" offset={4}
      style={{ width: triggerRef.current?.getBoundingClientRect().width }}>
      <div className="settings-select-menu__search"><input autoFocus value={query} spellCheck={false}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={activeIndex < 0 ? undefined : `${listId}-option-${activeIndex}`}
        aria-label={t("agentPresets.toolSearch")} placeholder={t("agentPresets.toolSearch")}
        onChange={event => { setQuery(event.target.value); setActive(null); }} onKeyDown={navigate} /></div>
      <div id={listId} role="listbox" aria-multiselectable="true" aria-label={t("agentPresets.toolList")} className="settings-select-menu__list">
        {options.map((option, index) => <Fragment key={`${option.group}:${option.value}:${option.add ? "add" : ""}`}>
          {!option.add && option.group !== options[index - 1]?.group && <div className="settings-select-menu__group">{groupLabel(option.group)}</div>}
          <div id={`${listId}-option-${index}`} role="option" aria-selected={selected.has(option.value)} title={option.hint || option.value}
            className={`settings-select-menu__option agent-preset-tools__option${index === activeIndex ? " is-active" : ""}`}
            onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(option.value)} onClick={() => pick(option)}>
            {option.add
              ? <span className="agent-preset-tools__add"><Plus size={14} aria-hidden="true" />{t("agentPresets.addCustomTool", { name: option.value })}</span>
              : <><span className="agent-preset-tools__check" aria-hidden="true">{selected.has(option.value) && <Check size={12} />}</span>
                <code>{option.value}</code>{option.hint && <span className="agent-preset-tools__hint">{option.hint}</span>}</>}
          </div>
        </Fragment>)}
        {!options.length && <div className="settings-select-menu__empty" role="status">{t("agentPresets.noToolMatches")}</div>}
      </div>
    </AnchoredPopover>
  </div>;
}
