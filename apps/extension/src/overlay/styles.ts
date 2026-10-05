// Injected as a <style> inside the overlay root. Every rule is scoped under
// .auxo-overlay so it is also safe when the root is a plain element.
export const OVERLAY_CSS = `
.auxo-overlay {
  all: initial;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1f2328;
  line-height: 1.4;
}
.auxo-overlay *, .auxo-overlay *::before, .auxo-overlay *::after {
  box-sizing: border-box;
}
.auxo-banner {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  max-width: 360px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-left: 4px solid #2f6feb;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  font-size: 14px;
}
.auxo-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 18, 22, 0.6);
}
.auxo-dialog {
  width: 100%;
  max-width: 440px;
  padding: 24px;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  font-size: 15px;
}
.auxo-dialog:focus { outline: none; }
.auxo-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
}
.auxo-banner .auxo-title { font-size: 15px; margin-bottom: 4px; }
.auxo-body { margin: 0; }
.auxo-stopped { margin: 0 0 8px; font-weight: 600; }
.auxo-countdown {
  margin: 16px 0 0;
  font-size: 14px;
  color: #57606a;
  font-variant-numeric: tabular-nums;
}
.auxo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
}
.auxo-button {
  appearance: none;
  padding: 8px 14px;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  color: #1f2328;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  cursor: pointer;
}
.auxo-button:hover:not(:disabled) { background: #eef1f4; }
.auxo-button:focus-visible { outline: 2px solid #2f6feb; outline-offset: 2px; }
.auxo-button:disabled { cursor: not-allowed; opacity: 0.55; }
.auxo-button-primary {
  color: #ffffff;
  background: #2f6feb;
  border-color: #2f6feb;
}
.auxo-button-primary:hover:not(:disabled) { background: #2a62d1; }
.auxo-dismiss {
  flex: none;
  padding: 2px 8px;
  font-size: 16px;
  line-height: 1;
}
`;
