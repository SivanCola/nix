import { BookOpen, Bot, Brain, Bug, Code, Database, FlaskConical, Globe, GraduationCap, Palette, PenLine, Rocket, Search, ShieldCheck, Sparkles, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const DEFAULT_AGENT_PRESET_ICON = "bot";

// Keys are persisted in preset files, so renaming one orphans saved presets
// (they fall back to the default glyph). Add keys; never rename them.
export const AGENT_PRESET_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  code: Code,
  terminal: SquareTerminal,
  "book-open": BookOpen,
  pen: PenLine,
  search: Search,
  bug: Bug,
  flask: FlaskConical,
  shield: ShieldCheck,
  palette: Palette,
  rocket: Rocket,
  brain: Brain,
  sparkles: Sparkles,
  database: Database,
  globe: Globe,
  school: GraduationCap,
};

export function AgentPresetIcon({ icon, size = 16 }: { icon?: string; size?: number }) {
  const Glyph = (icon && AGENT_PRESET_ICONS[icon]) || Bot;
  return <Glyph size={size} aria-hidden="true" />;
}
