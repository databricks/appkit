export const styles = `
:host {
  all: initial;
}
* { box-sizing: border-box; }
.overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: start center;
  padding: clamp(40px, 14vh, 160px) 16px 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #e4e4e7;
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease;
}
.overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(24px) saturate(1.2);
  -webkit-backdrop-filter: blur(24px) saturate(1.2);
}
.palette {
  position: relative;
  width: min(640px, calc(100vw - 32px));
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(24, 24, 27, 0.98);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.4),
    0 24px 68px rgba(0, 0, 0, 0.55),
    0 8px 24px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  transform: translateY(8px) scale(0.98);
  opacity: 0;
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease;
}
.overlay.open .palette {
  transform: none;
  opacity: 1;
}
.palette::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  pointer-events: none;
}
.header {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-mark {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #818cf8;
  box-shadow: 0 0 12px rgba(129, 140, 248, 0.5);
}
.brand-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.bridge-pill {
  display: inline-flex;
  align-items: center;
  max-width: 200px;
  padding: 2px 10px;
  height: 22px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.35);
  font-size: 11px;
  font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.search-icon {
  color: rgba(255, 255, 255, 0.3);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.search-icon svg {
  width: 18px;
  height: 18px;
}
.command-input {
  flex: 1;
  border: 0;
  outline: none;
  background: transparent;
  color: #fafafa;
  font-size: 17px;
  font-weight: 500;
  letter-spacing: -0.02em;
  padding: 6px 0;
  caret-color: #818cf8;
}
.command-input::placeholder {
  color: rgba(255, 255, 255, 0.25);
}
.shortcut-pills {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.body {
  padding: 8px;
}
.section-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 8px 8px 4px;
}
.command-list {
  display: grid;
  gap: 2px;
  max-height: min(40vh, 320px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
}
.command-list::-webkit-scrollbar { width: 4px; }
.command-list::-webkit-scrollbar-track { background: transparent; }
.command-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}
.command-item {
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #e4e4e7;
  padding: 10px;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  transition: background 80ms ease;
}
.command-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.command-item.active {
  background: rgba(129, 140, 248, 0.1);
}
.command-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.command-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  color: #a5b4fc;
}
.command-icon svg {
  width: 16px;
  height: 16px;
}
.command-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.command-title {
  font-size: 13px;
  font-weight: 500;
  color: #fafafa;
}
.command-subtitle {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.command-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.command-tag {
  padding: 2px 8px;
  height: 20px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  font-weight: 500;
}
.divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 8px;
}
.summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
  margin: 4px;
}
.summary div {
  padding: 8px 10px;
  background: rgba(24, 24, 27, 0.98);
  font-size: 12px;
  color: #e4e4e7;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary strong {
  display: block;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.status {
  font-size: 12px;
  color: #818cf8;
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 0;
  transition: opacity 150ms ease;
}
.status:empty {
  display: none;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #818cf8;
  flex-shrink: 0;
  animation: pulse-dot 1.2s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
.prompt-shell {
  display: grid;
  gap: 6px;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease, padding 300ms ease;
  padding: 0 4px;
}
.prompt-shell.visible {
  max-height: 360px;
  opacity: 1;
  padding: 4px;
}
.prompt {
  width: 100%;
  min-height: 120px;
  max-height: 200px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.3);
  color: #d4d4d8;
  padding: 12px;
  font: 12px/1.6 ui-monospace, "SF Mono", "Cascadia Code", monospace;
  box-sizing: border-box;
}
.prompt:focus {
  outline: none;
  border-color: rgba(129, 140, 248, 0.3);
}
.footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.footer-hints {
  display: flex;
  gap: 12px;
}
.hint {
  display: flex;
  align-items: center;
  gap: 4px;
  color: rgba(255, 255, 255, 0.25);
  font-size: 11px;
}
kbd {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.45);
  font: 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
  font-weight: 500;
}
.meta-link {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.2);
}
.empty-state {
  padding: 20px;
  color: rgba(255, 255, 255, 0.3);
  font-size: 13px;
  text-align: center;
}
@media (max-width: 640px) {
  .summary { grid-template-columns: repeat(2, 1fr); }
  .command-meta { display: none; }
  .bridge-pill { display: none; }
}
@media (max-width: 480px) {
  .summary { grid-template-columns: 1fr; }
  .shortcut-pills { display: none; }
}
.pick-highlight {
  position: fixed;
  z-index: 2147483646;
  pointer-events: none;
  border: 2px solid #818cf8;
  background: rgba(129, 140, 248, 0.08);
  border-radius: 4px;
  transition: top 60ms ease, left 60ms ease, width 60ms ease, height 60ms ease;
}
.pick-label {
  position: fixed;
  z-index: 2147483646;
  pointer-events: none;
  padding: 3px 8px;
  border-radius: 4px;
  background: #818cf8;
  color: #fff;
  font: 500 11px/1.3 ui-monospace, "SF Mono", monospace;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.picked-element-card {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 10px;
  background: rgba(129, 140, 248, 0.06);
  border: 1px solid rgba(129, 140, 248, 0.15);
  margin: 4px;
}
.picked-tag {
  font: 500 12px/1 ui-monospace, "SF Mono", monospace;
  color: #a5b4fc;
}
.picked-detail {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prompt-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px;
}
.agent-buttons {
  display: flex;
  gap: 6px;
  padding: 4px;
  flex-wrap: wrap;
}
.agent-btn {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #e4e4e7;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 100ms ease, border-color 100ms ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-btn:hover {
  background: rgba(129, 140, 248, 0.1);
  border-color: rgba(129, 140, 248, 0.3);
}
.agent-btn.primary {
  background: #818cf8;
  border-color: #818cf8;
  color: #fff;
}
.agent-btn.primary:hover {
  background: #6366f1;
}
.agent-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.agent-stream-output {
  max-height: 120px;
  overflow-y: auto;
  padding: 8px 10px;
  margin: 4px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  font: 12px/1.5 ui-monospace, "SF Mono", monospace;
  color: #a5b4fc;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
}
.agent-stream-output:empty { display: none; }
.agent-pill {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(24, 24, 27, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.3),
    0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #e4e4e7;
  opacity: 0;
  transform: translateY(12px) scale(0.95);
  pointer-events: none;
  transition: opacity 200ms ease, transform 250ms cubic-bezier(0.16, 1, 0.3, 1);
  max-width: min(380px, calc(100vw - 40px));
}
.agent-pill.visible {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.agent-pill.done {
  border-color: rgba(74, 222, 128, 0.25);
}
.agent-pill.error {
  border-color: rgba(248, 113, 113, 0.3);
}
.agent-pill:hover {
  border-color: rgba(129, 140, 248, 0.4);
}
.agent-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #818cf8;
  box-shadow: 0 0 10px rgba(129, 140, 248, 0.5);
  animation: pulse-dot 1.2s ease-in-out infinite;
}
.agent-pill.done .agent-pill-dot {
  background: #4ade80;
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.5);
  animation: none;
}
.agent-pill.error .agent-pill-dot {
  background: #f87171;
  box-shadow: 0 0 10px rgba(248, 113, 113, 0.5);
  animation: none;
}
.agent-pill-text {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.agent-pill-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
`;
