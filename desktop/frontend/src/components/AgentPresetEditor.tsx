import { useEffect, useId, useRef, useState } from "react";
import { AGENT_PRESET_ID_PATTERN, type AgentPreset, type WritableAgentPresetScope } from "../lib/agentPresets";
import { useT } from "../lib/i18n";
import { AGENT_PRESET_ICONS, AgentPresetIcon, DEFAULT_AGENT_PRESET_ICON } from "./AgentPresetIcon";
import { AgentPresetToolPicker } from "./AgentPresetToolPicker";
import { SettingsField, SettingsSection } from "./SettingsForm";
import { SettingsOptions } from "./SettingsOptions";
import { SettingsSelect } from "./SettingsSelect";

export type AgentPresetDraft = Pick<AgentPreset, "id" | "name" | "description" | "icon" | "body" | "keepCoding" | "complete" | "includeRuntimeContext" | "tools"> & { scope: WritableAgentPresetScope };

export function AgentPresetEditor({ initial, editing, presets, busy, onSave, onCancel }: {
  initial: AgentPresetDraft;
  editing: boolean;
  presets: AgentPreset[];
  busy: boolean;
  onSave: (draft: AgentPresetDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const prefix = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initial);
  // Unchecking "restrict" keeps the list so re-checking restores it.
  const [lastTools, setLastTools] = useState(initial.tools ?? []);
  const id = draft.id.trim();
  const idInvalid = !AGENT_PRESET_ID_PATTERN.test(id) || id === "default";
  const idTaken = !editing && presets.some(preset => preset.id === id && preset.scope === draft.scope);
  const bodyRequired = draft.complete || !draft.keepCoding;
  const replacementMissing = bodyRequired && !draft.body.trim();
  const invalid = idInvalid || idTaken || !draft.name.trim() || replacementMissing;
  const patch = (next: Partial<AgentPresetDraft>) => setDraft(previous => ({ ...previous, ...next }));
  useEffect(() => { nameRef.current?.focus(); }, []);

  return <form className="agent-preset-editor" aria-label={t(editing ? "agentPresets.edit" : "agentPresets.new")}
    onSubmit={event => { event.preventDefault(); if (!invalid && !busy) void onSave({ ...draft, id }); }}>
    <button className="subagents-form-back" type="button" disabled={busy} onClick={onCancel}>{t("agentPresets.back")}</button>
    <SettingsSection title={<h2>{t(editing ? "agentPresets.edit" : "agentPresets.new")}</h2>} description={t("agentPresets.editHint")}>
      <SettingsField label={<label htmlFor={`${prefix}-name`}>{t("agentPresets.name")}</label>}>
        <input ref={nameRef} id={`${prefix}-name`} className="mem-input set-grow" required value={draft.name} disabled={busy} onChange={event => patch({ name: event.target.value })} />
      </SettingsField>
      <SettingsField label={<label htmlFor={`${prefix}-id`}>{t("agentPresets.id")}</label>} hint={t(editing ? "agentPresets.idFixed" : "agentPresets.idHint")}>
        <div className="agent-preset-editor__field">
          <input id={`${prefix}-id`} className="mem-input set-grow" required value={draft.id} disabled={editing || busy} autoCapitalize="none" spellCheck={false}
            aria-invalid={!!id && (idInvalid || idTaken)} aria-describedby={`${prefix}-id-error`}
            onChange={event => patch({ id: event.target.value })} />
          <span id={`${prefix}-id-error`} className="agent-preset-editor__error" role="status">{id && idInvalid ? t("agentPresets.idInvalid") : idTaken ? t("agentPresets.idTaken") : ""}</span>
        </div>
      </SettingsField>
      <SettingsField label={<label htmlFor={`${prefix}-description`}>{t("agentPresets.description")}</label>}>
        <input id={`${prefix}-description`} className="mem-input set-grow" value={draft.description} disabled={busy} onChange={event => patch({ description: event.target.value })} />
      </SettingsField>
      <SettingsField label={t("agentPresets.icon")} hint={t("agentPresets.iconHint")}>
        <div className="agent-preset-editor__icons" role="radiogroup" aria-label={t("agentPresets.icon")}>
          {Object.keys(AGENT_PRESET_ICONS).map(key => {
            const on = (draft.icon || DEFAULT_AGENT_PRESET_ICON) === key;
            return <button type="button" key={key} role="radio" aria-checked={on} aria-label={key} title={key} disabled={busy}
              className={`agent-preset-editor__icon${on ? " agent-preset-editor__icon--on" : ""}`}
              onClick={() => patch({ icon: key === DEFAULT_AGENT_PRESET_ICON ? "" : key })}><AgentPresetIcon icon={key} /></button>;
          })}
        </div>
      </SettingsField>
      <SettingsField label={t("agentPresets.scope")} hint={t("agentPresets.scopeHint")}>
        <SettingsSelect value={draft.scope} disabled={editing || busy} aria-label={t("agentPresets.scope")}
          onValueChange={value => patch({ scope: value as WritableAgentPresetScope })}
          options={[{ value: "user", label: t("agentPresets.scope.user") }, { value: "project", label: t("agentPresets.scope.project") }]} />
      </SettingsField>
      <SettingsField label={<label htmlFor={`${prefix}-complete`}>{t("agentPresets.complete")}</label>} hint={<span id={`${prefix}-complete-hint`}>{t("agentPresets.completeHint")}</span>}>
        <input id={`${prefix}-complete`} type="checkbox" checked={draft.complete} disabled={busy} aria-describedby={`${prefix}-complete-hint`}
          onChange={event => patch({ complete: event.target.checked })} />
      </SettingsField>
      <SettingsField label={t("agentPresets.keepCoding")} hint={<span id={`${prefix}-coding-hint`}>{t(draft.complete ? "agentPresets.keepCodingCompleteHint" : "agentPresets.keepCodingHint")}</span>}>
        <SettingsOptions className="set-seg" role="group" aria-label={t("agentPresets.keepCoding")} aria-describedby={`${prefix}-coding-hint`}>
          {[true, false].map(value => <button type="button" key={String(value)} disabled={busy || draft.complete} aria-pressed={draft.keepCoding === value}
            className={`set-seg__btn${draft.keepCoding === value ? " set-seg__btn--on" : ""}`} onClick={() => patch({ keepCoding: value })}>
            {t(value ? "agentPresets.keep" : "agentPresets.replace")}
          </button>)}
        </SettingsOptions>
      </SettingsField>
      <SettingsField label={<label htmlFor={`${prefix}-runtime-context`}>{t("agentPresets.includeRuntimeContext")}</label>} hint={<span id={`${prefix}-runtime-context-hint`}>{t("agentPresets.includeRuntimeContextHint")}</span>}>
        <input id={`${prefix}-runtime-context`} type="checkbox" checked={draft.includeRuntimeContext} disabled={busy} aria-describedby={`${prefix}-runtime-context-hint`}
          onChange={event => patch({ includeRuntimeContext: event.target.checked })} />
      </SettingsField>
      <SettingsField label={<label htmlFor={`${prefix}-body`}>{t("agentPresets.body")}</label>} stacked>
        <textarea id={`${prefix}-body`} className="mem-textarea" rows={8} value={draft.body} disabled={busy} required={bodyRequired}
          aria-invalid={replacementMissing} aria-describedby={`${prefix}-body-hint`} onChange={event => patch({ body: event.target.value })} />
        <span id={`${prefix}-body-hint`} className={replacementMissing ? "agent-preset-editor__error" : "set-hint"}>{t(replacementMissing ? draft.complete ? "agentPresets.completeBodyRequired" : "agentPresets.bodyRequired" : "agentPresets.bodyHint")}</span>
      </SettingsField>
      <SettingsField label={t("agentPresets.tools")} hint={t("agentPresets.toolsHint")} stacked>
        <label className="agent-preset-editor__restrict"><input type="checkbox" checked={draft.tools !== null} disabled={busy}
          onChange={event => patch({ tools: event.target.checked ? lastTools : null })} />{t("agentPresets.restrictTools")}</label>
        {draft.tools !== null && <>
          <AgentPresetToolPicker id={`${prefix}-tools`} value={draft.tools} disabled={busy}
            onChange={tools => { setLastTools(tools); patch({ tools }); }} />
          <div className="agent-preset-editor__tools-footer">
            <span id={`${prefix}-tools-hint`} className="set-hint" role="status">{t(draft.tools.length ? "agentPresets.toolListHint" : "agentPresets.noTools")}</span>
            <button type="button" className="btn btn--small" disabled={busy || !draft.tools.length} onClick={() => { setLastTools([]); patch({ tools: [] }); }}>{t("agentPresets.clearTools")}</button>
          </div>
        </>}
      </SettingsField>
    </SettingsSection>
    <div className="settings-save-bar">
      <span role="status">{t("agentPresets.saveHint")}</span>
      <button className="btn btn--small" type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
      <button className="btn btn--primary btn--small" type="submit" disabled={busy || invalid}>{t(busy ? "agentPresets.saving" : "common.save")}</button>
    </div>
  </form>;
}
