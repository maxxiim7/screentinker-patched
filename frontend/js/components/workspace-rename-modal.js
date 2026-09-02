import { t } from '../i18n.js';
import { api } from '../api.js';

// Open a rename modal for the given workspace. Uses the existing .modal-overlay
// / .modal / .modal-header / .modal-body / .modal-footer CSS classes. On
// successful save, reloads the page (matches the workspace-switch flow).
export function openWorkspaceRenameModal(workspace) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Rename workspace</h3>
        <button class="btn-icon" type="button" data-rename-close aria-label="${t('common.close')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="renameWsName">Name</label>
          <input id="renameWsName" type="text" class="input" maxlength="80" value="${esc(workspace.name || '')}" style="width:100%">
        </div>
        <div class="form-group">
          <label for="renameWsSlug">Slug <span style="color:var(--text-muted);font-weight:400">(optional, URL-safe)</span></label>
          <input id="renameWsSlug" type="text" class="input" maxlength="60" value="${esc(workspace.slug || '')}" placeholder="e.g. studio-a" style="width:100%">
          <div style="color:var(--text-muted);font-size:11px;margin-top:4px">Lowercase letters, digits, hyphens. Must be unique within the organization.</div>
        </div>
        <div id="renameWsError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-rename-close>Cancel</button>
        <button class="btn btn-primary" type="button" id="renameWsSave">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#renameWsName');
  const slugInput = overlay.querySelector('#renameWsSlug');
  const errorEl = overlay.querySelector('#renameWsError');
  const saveBtn = overlay.querySelector('#renameWsSave');
  nameInput.focus();
  nameInput.select();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.target === nameInput || e.target === slugInput)) save();
  }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-rename-close]').forEach(b => b.addEventListener('click', close));

  async function save() {
    errorEl.style.display = 'none';
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name) { showError('Name cannot be empty'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await api.renameWorkspace(workspace.id, { name, slug });
      window.location.reload();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      showError(err.message || 'Rename failed');
    }
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  saveBtn.addEventListener('click', save);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
