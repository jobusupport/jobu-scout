// ── Sidebar collapse & dropdown menus ────────────────────────────────────
function toggleSidebar() {
  const layout = document.getElementById('appLayout');
  if (!layout) return;
  const collapsed = layout.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('jobuSidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
}
try {
  if (localStorage.getItem('jobuSidebarCollapsed') === '1') {
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('appLayout')?.classList.add('sidebar-collapsed');
    });
  }
} catch (e) {}

function closeAllMenus() {
  document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', closeAllMenus);
function toggleTeamMenu(evt, id) {
  evt.stopPropagation();
  const menu = document.getElementById('teamMenu-' + id);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeAllMenus();
  if (!isOpen) menu.classList.add('open');
}
function toggleMoreMenu(evt) {
  evt.stopPropagation();
  const menu = document.getElementById('pipelineMoreMenu');
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeAllMenus();
  if (!isOpen) menu.classList.add('open');
}
