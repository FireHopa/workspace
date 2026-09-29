const state = {
  config: null,
  settings: null,
  settingsWritable: true,
  history: [],
  planner: [],
  templates: [],
  templateFilter: '',
  networkContent: {},
  kind: 'text',
  file: null,
  objectUrl: null,
  mediaMeta: { duration: null, width: null, height: null },
  publishing: false,
  tiktokCreator: null,
  publishStep: 1,
  maxPublishStep: 1,
  previewPlatform: null,
  historyFilters: { query: '', platform: 'all', status: 'all', kind: 'all' },
  adminTab: 'integrations',
  diagnostics: null,
  canAdmin: false,
  plannerEditId: null,
  plannerExistingMedia: null,
  plannerRemoveMedia: false,
  plannerDirty: false,
  draftFilters: { query: '', status: 'all' },
  calendarCursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  loadErrors: { history: null, planner: null, templates: null },
  eventsBound: false,
  bootReady: false,
};

const $ = (id) => document.getElementById(id);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function friendlyRequestError(error, fallback = 'Não foi possível concluir esta ação.') {
  const message = String(error?.message || '').trim();
  if (!message) return fallback;
  if (/aborted|aborterror|tempo limite|timeout/i.test(message)) return 'O servidor demorou demais para responder. Tente novamente em alguns instantes.';
  if (/failed to fetch|networkerror|network request failed|load failed|fetch/i.test(message)) return 'Não foi possível comunicar com o Social Publisher. Confira sua conexão e tente novamente.';
  return message;
}

function setConnectivityState(mode = 'online', detail = '') {
  const banner = $('connectivityBanner');
  if (!banner) return;
  const title = $('connectivityTitle');
  const copy = $('connectivityDetail');
  const icon = $('connectivityIcon');
  const retry = $('connectivityRetryBtn');
  banner.className = `connectivity-banner ${mode === 'online' ? 'hidden' : mode}`;
  if (retry) retry.textContent = mode === 'session' ? 'Entrar novamente' : 'Tentar novamente';
  if (mode === 'offline') {
    icon.textContent = '×';
    title.textContent = 'Você está offline';
    copy.textContent = detail || 'As alterações não podem ser enviadas enquanto a conexão não voltar.';
  } else if (mode === 'session') {
    icon.textContent = '!';
    title.textContent = 'Sua sessão precisa ser renovada';
    copy.textContent = detail || 'Entre novamente no Workspace para continuar usando o Social Publisher.';
  } else if (mode === 'degraded') {
    icon.textContent = '!';
    title.textContent = 'Servidor temporariamente indisponível';
    copy.textContent = detail || 'Alguns dados podem estar desatualizados. Tente novamente em instantes.';
  }
}

function setBootState(mode = 'loading', message = '') {
  const overlay = $('appBootOverlay');
  if (!overlay) return;
  const spinner = $('appBootSpinner');
  const retry = $('appBootRetryBtn');
  const title = $('appBootTitle');
  const copy = $('appBootMessage');
  if (mode === 'ready') {
    overlay.classList.add('hidden');
    state.bootReady = true;
    return;
  }
  overlay.classList.remove('hidden');
  state.bootReady = false;
  if (mode === 'error') {
    spinner?.classList.add('hidden');
    retry?.classList.remove('hidden');
    title.textContent = 'Não conseguimos abrir o Social Publisher';
    copy.textContent = message || 'O servidor não respondeu. Tente novamente.';
  } else {
    spinner?.classList.remove('hidden');
    retry?.classList.add('hidden');
    title.textContent = 'Preparando o Social Publisher';
    copy.textContent = message || 'Carregando contas, publicações e planejamento...';
  }
}

async function apiFetch(resource, options = {}) {
  const requestOptions = { ...options };
  const customTimeout = Number(requestOptions.timeoutMs || 0);
  delete requestOptions.timeoutMs;
  const hasFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
  const timeoutMs = customTimeout || (hasFormData ? 15 * 60 * 1000 : 35_000);
  const controller = new AbortController();
  const inheritedSignal = requestOptions.signal;
  if (!inheritedSignal) requestOptions.signal = controller.signal;
  const timer = inheritedSignal ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resource, requestOptions);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (response.redirected && contentType.includes('text/html')) {
      setConnectivityState('session');
      throw new Error('Sua sessão do Workspace expirou. Entre novamente para continuar.');
    }
    if (response.status === 401) setConnectivityState('session');
    else if ([502, 503, 504].includes(response.status)) setConnectivityState('degraded');
    else if (navigator.onLine) setConnectivityState('online');
    return response;
  } catch (error) {
    if (!navigator.onLine) setConnectivityState('offline');
    else setConnectivityState('degraded', friendlyRequestError(error));
    if (error?.name === 'AbortError') throw new Error('Tempo limite excedido ao aguardar o servidor.');
    throw new Error(friendlyRequestError(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function loadErrorHtml(scope, title, message = '') {
  return `<div class="empty-state load-error"><span>!</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message || 'Não foi possível carregar estes dados agora.')}</p><button type="button" data-retry-load="${escapeHtml(scope)}">Tentar novamente</button></div>`;
}

const networks = {
  youtube: { label: 'YouTube', auth: 'auth/youtube', logo: '▶', logoClass: 'youtube-logo' },
  instagram: { label: 'Instagram', auth: 'auth/instagram', logo: '◎', logoClass: 'instagram-logo' },
  linkedin: { label: 'LinkedIn', auth: 'auth/linkedin', logo: 'in', logoClass: 'linkedin-logo' },
  tiktok: { label: 'TikTok', auth: 'auth/tiktok', logo: '♪', logoClass: 'tiktok-logo' },
  facebook: { label: 'Facebook', auth: 'auth/facebook', logo: 'f', logoClass: 'facebook-logo' },
  googleBusiness: { label: 'Google Meu Negócio', auth: 'auth/google-business', logo: 'G', logoClass: 'googlebusiness-logo' },
};

const variantRules = {
  youtube: { titleLabel: 'Título do vídeo', captionLabel: 'Descrição', titleMax: 100, captionMax: 5000, showTitle: true },
  instagram: { captionLabel: 'Legenda do Instagram', captionMax: 2200, showTitle: false },
  linkedin: { titleLabel: 'Título interno', captionLabel: 'Texto do LinkedIn', captionMax: 3000, showTitle: true },
  tiktok: { captionLabel: 'Legenda do TikTok', captionMax: 2200, showTitle: false },
  facebook: { titleLabel: 'Título', captionLabel: 'Texto do Facebook', captionMax: 5000, showTitle: true },
  googleBusiness: { titleLabel: 'Título', captionLabel: 'Texto do Google', captionMax: 3000, showTitle: true },
};


const pageMeta = {
  dashboard: {
    eyebrow: 'SOCIAL PUBLISHER',
    title: 'Visão geral',
    subtitle: 'Acompanhe suas redes e publique conteúdo em um só lugar.',
  },
  publish: {
    eyebrow: 'PUBLICAÇÃO',
    title: 'Nova publicação',
    subtitle: 'Crie o conteúdo, escolha os destinos e revise antes de enviar.',
  },
  calendar: {
    eyebrow: 'PLANEJAMENTO',
    title: 'Calendário editorial',
    subtitle: 'Organize e acompanhe as publicações agendadas.',
  },
  drafts: {
    eyebrow: 'CONTEÚDO',
    title: 'Rascunhos',
    subtitle: 'Continue conteúdos salvos e revise itens pendentes.',
  },
  templates: {
    eyebrow: 'BIBLIOTECA',
    title: 'Templates',
    subtitle: 'Reutilize estruturas e versões de conteúdo já preparadas para suas redes.',
  },
  publications: {
    eyebrow: 'CONTEÚDO',
    title: 'Publicações',
    subtitle: 'Consulte o histórico e o resultado de cada envio.',
  },
  connections: {
    eyebrow: 'CONTAS',
    title: 'Contas conectadas',
    subtitle: 'Gerencie os perfis que estão disponíveis para publicação.',
  },
  admin: {
    eyebrow: 'SISTEMA',
    title: 'Administração',
    subtitle: 'Configurações técnicas, credenciais e integrações do Social Publisher.',
  },
};

const pageAliases = {
  settings: 'admin',
  'history-section': 'publications',
  history: 'publications',
};

function normalizePage(page) {
  const clean = String(page || '').replace(/^#/, '').trim();
  const mapped = pageAliases[clean] || clean;
  return pageMeta[mapped] ? mapped : 'dashboard';
}

function setSidebarOpen(open) {
  document.body.classList.toggle('sidebar-open', Boolean(open));
}

function navigateToPage(rawPage, { updateHash = true, scroll = true } = {}) {
  let page = normalizePage(rawPage);
  if (page === 'admin' && state.config && !state.canAdmin) {
    page = 'dashboard';
    toast('A Administração é exclusiva para administradores do Social Publisher.', 'error');
  }
  const targetHash = `#${page}`;
  if (updateHash && window.location.hash !== targetHash) {
    window.location.hash = targetHash;
    return;
  }

  $$('.app-page').forEach((node) => node.classList.toggle('active', node.dataset.page === page));
  $$('[data-page-target]').forEach((node) => node.classList.toggle('active', node.dataset.pageTarget === page));

  const meta = pageMeta[page];
  if ($('pageEyebrow')) $('pageEyebrow').textContent = meta.eyebrow;
  if ($('pageTitle')) $('pageTitle').textContent = meta.title;
  if ($('pageSubtitle')) $('pageSubtitle').textContent = meta.subtitle;
  if ($('headerPrimaryAction')) $('headerPrimaryAction').classList.toggle('hidden', page === 'publish');
  document.title = `${meta.title} · Casa do Ads Social Publisher`;
  setSidebarOpen(false);
  if (page === 'admin' && state.canAdmin && !state.diagnostics) loadDiagnostics().catch((error) => console.warn(error));
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
}

function applyAccessControl() {
  state.canAdmin = Boolean(state.config?.permissions?.canAdmin);
  $$('[data-admin-only]').forEach((node) => node.classList.toggle('hidden', !state.canAdmin));
  if ($('sidebarRoleBadge')) {
    $('sidebarRoleBadge').textContent = state.config?.user?.roleLabel || (state.canAdmin ? 'Administrador' : 'Operador');
    $('sidebarRoleBadge').className = `sidebar-role ${state.canAdmin ? 'admin' : 'operator'}`;
  }
  if (!state.canAdmin && normalizePage(window.location.hash) === 'admin') {
    window.history.replaceState({}, '', `${window.location.pathname}#dashboard`);
  }
}

function setAdminTab(tab) {
  const next = ['integrations', 'system', 'diagnostics'].includes(tab) ? tab : 'integrations';
  state.adminTab = next;
  $$('[data-admin-tab-target]').forEach((button) => {
    const active = button.dataset.adminTabTarget === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('[data-admin-tab-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.adminTabPanel === next));
  if (next === 'diagnostics' && state.canAdmin) loadDiagnostics().catch((error) => toast(error.message, 'error'));
}

const fallbackRules = {
  youtube: { mediaKinds: ['video'], requiresLocalFile: true, titleMax: 100, descriptionMaxBytes: 5000 },
  instagram: {
    mediaKinds: ['image', 'video'], requiresPublicMediaUrl: true,
    videoMimeTypes: ['video/mp4', 'video/quicktime'], videoMaxBytes: 1024 ** 3,
    videoDurationMinSec: 3, videoDurationMaxSec: 900, videoMaxWidth: 1920,
  },
  linkedin: {
    mediaKinds: ['text', 'image', 'video'], localFileForMedia: true, commentaryMax: 3000,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'], videoMimeTypes: ['video/mp4'],
    videoMinBytes: 75 * 1024, videoMaxBytes: 500 * 1024 * 1024,
    videoDurationMinSec: 3, videoDurationMaxSec: 1800,
  },
  tiktok: {
    mediaKinds: ['image', 'video'], videoMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    videoMaxBytes: 4 * 1024 * 1024 * 1024, captionMax: 2200, photoDescriptionMax: 4000,
    videoMinWidth: 360, videoMaxWidth: 4096, requiresVerifiedPhotoUrl: true,
  },
  facebook: {
    mediaKinds: ['text', 'image', 'video'], imageRequiresPublicUrl: true, videoRequiresLocalFile: true,
    reelDurationMinSec: 4, reelDurationMaxSec: 60, reelMinWidth: 540, reelMinHeight: 960,
  },
  googleBusiness: { mediaKinds: ['text', 'image'], imageRequiresPublicUrl: true },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function updateFileMetaLabel() {
  if (!state.file) return;
  const extra = [];
  const duration = formatDuration(state.mediaMeta.duration);
  if (duration) extra.push(duration);
  if (state.mediaMeta.width && state.mediaMeta.height) extra.push(`${state.mediaMeta.width}x${state.mediaMeta.height}`);
  $('fileMeta').textContent = [formatBytes(state.file.size), state.file.type || 'arquivo', ...extra].join(' · ');
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value || '--';
  }
}

function formatDayTime(value) {
  try {
    return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch {
    return value || '--';
  }
}

function currentMediaInfo() {
  if (state.file) return {
    name: state.file.name,
    size: state.file.size,
    type: state.file.type,
    url: state.objectUrl,
    persisted: false,
    available: true,
  };
  const media = state.plannerExistingMedia;
  if (media?.available) return {
    name: media.originalName || 'Mídia salva',
    size: Number(media.size || 0),
    type: media.mimetype || '',
    url: media.publicUrl || state.objectUrl || null,
    persisted: true,
    available: true,
  };
  return null;
}

function markPlannerDirty() {
  state.plannerDirty = true;
  if ($('composerSaveState')) $('composerSaveState').textContent = state.plannerEditId ? 'Alterações ainda não salvas' : 'Conteúdo ainda não salvo';
}

function markPlannerSaved(label = 'Salvo') {
  state.plannerDirty = false;
  if ($('composerSaveState')) $('composerSaveState').textContent = label;
}

function plannerStatusMeta(status) {
  const map = {
    draft: { label: 'Rascunho', className: 'neutral', icon: '✎' },
    scheduled: { label: 'Agendado', className: 'info', icon: '□' },
    processing: { label: 'Publicando', className: 'warning', icon: '◌' },
    published: { label: 'Publicado', className: 'success', icon: '✓' },
    failed: { label: 'Falhou', className: 'error', icon: '!' },
    partial: { label: 'Parcial', className: 'warning', icon: '!' },
    needs_review: { label: 'Revisão necessária', className: 'warning', icon: '!' },
  };
  return map[status] || { label: status || 'Rascunho', className: 'neutral', icon: '•' };
}

function toast(message, type = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

function setAlert(message = '', type = '') {
  const node = $('publishAlert');
  if (!message) {
    node.className = 'alert hidden';
    node.textContent = '';
    return;
  }
  node.className = `alert ${type}`;
  node.textContent = message;
}

function selectedPlatforms() {
  return $$('input[name="platform"]:checked').map((input) => input.value);
}

function activeNetworkContent() {
  const active = {};
  for (const platform of selectedPlatforms()) {
    const value = state.networkContent?.[platform];
    if (value?.customized) active[platform] = structuredClone(value);
  }
  return active;
}

function currentRules() {
  return state.config?.platformRules || fallbackRules;
}

function variantFor(platform) {
  return state.networkContent?.[platform]?.customized ? state.networkContent[platform] : null;
}

function contentForPlatform(platform) {
  const variant = variantFor(platform);
  return {
    title: variant ? String(variant.title || '') : $('title').value.trim(),
    caption: variant ? String(variant.caption || '') : $('caption').value.trim(),
    customized: Boolean(variant),
    generated: Boolean(variant?.generated),
  };
}

function smartTrim(value, max) {
  const text = String(value || '').trim();
  if (!max || text.length <= max) return text;
  const sliced = text.slice(0, Math.max(1, max - 1));
  const wordCut = sliced.lastIndexOf(' ');
  return `${(wordCut > max * 0.65 ? sliced.slice(0, wordCut) : sliced).trim()}…`;
}

function smartTrimBytes(value, maxBytes) {
  const text = String(value || '').trim();
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(`${text.slice(0, mid)}…`).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return smartTrim(text.slice(0, Math.max(1, low)), Math.max(1, low)) + (low < text.length ? '…' : '');
}

function joinedBaseText() {
  const title = $('title').value.trim();
  const caption = $('caption').value.trim();
  if (title && caption && !caption.toLowerCase().startsWith(title.toLowerCase())) return `${title}\n\n${caption}`;
  return caption || title;
}

function autoVariant(platform) {
  const title = $('title').value.trim();
  const caption = $('caption').value.trim();
  const combined = joinedBaseText();
  if (platform === 'youtube') return { customized: true, generated: true, title: smartTrim(title || caption.split(/\n/)[0] || 'Vídeo', 100), caption: smartTrimBytes(caption || title, 5000) };
  if (platform === 'instagram') return { customized: true, generated: true, title: '', caption: smartTrim(combined, 2200) };
  if (platform === 'linkedin') return { customized: true, generated: true, title: smartTrim(title, 100), caption: smartTrim(combined, 3000) };
  if (platform === 'tiktok') {
    const max = state.kind === 'image' ? 4000 : 2200;
    return { customized: true, generated: true, title: '', caption: smartTrim(combined, max) };
  }
  if (platform === 'facebook') return { customized: true, generated: true, title: smartTrim(title, 120), caption: smartTrim(combined, 5000) };
  if (platform === 'googleBusiness') return { customized: true, generated: true, title: smartTrim(title, 120), caption: smartTrim(combined, 3000) };
  return { customized: true, generated: true, title, caption };
}

function generateNetworkVariants() {
  const platforms = selectedPlatforms();
  if (!platforms.length) return toast('Selecione pelo menos uma rede antes de gerar versões.', 'error');
  if (!$('title').value.trim() && !$('caption').value.trim()) return toast('Escreva o conteúdo principal antes de gerar versões.', 'error');
  for (const platform of platforms) state.networkContent[platform] = autoVariant(platform);
  markPlannerDirty();
  renderNetworkVariants();
  refreshUi();
  toast(`Versões geradas para ${platforms.length} rede${platforms.length === 1 ? '' : 's'}. Revise antes de publicar.`, 'success');
}

function resetNetworkVariants() {
  const platforms = selectedPlatforms();
  for (const platform of platforms) delete state.networkContent[platform];
  markPlannerDirty();
  renderNetworkVariants();
  refreshUi();
  toast('Todas as redes voltaram a usar o conteúdo principal.');
}

function renderNetworkVariants() {
  const container = $('networkVariantsList');
  if (!container) return;
  const platforms = selectedPlatforms();
  if (!platforms.length) {
    container.innerHTML = '<div class="empty-state compact">Selecione pelo menos uma rede para personalizar o conteúdo.</div>';
    return;
  }
  container.innerHTML = platforms.map((platform) => {
    const meta = networks[platform];
    const rules = variantRules[platform] || { showTitle: true, captionMax: 3000 };
    const variant = variantFor(platform);
    const effective = contentForPlatform(platform);
    const titleField = rules.showTitle ? `<label class="field compact-field variant-title-field"><span class="field-label"><b>${escapeHtml(rules.titleLabel || 'Título')}</b><em>${effective.title.length}${rules.titleMax ? `/${rules.titleMax}` : ''}</em></span><input type="text" data-variant-title="${platform}" value="${escapeHtml(effective.title)}" ${variant ? '' : 'disabled'} maxlength="${rules.titleMax || 500}" /></label>` : '';
    const maxCaption = platform === 'tiktok' && state.kind === 'image' ? 4000 : (rules.captionMax || 3000);
    return `<article class="variant-card ${variant ? 'customized' : ''}" data-variant-card="${platform}">
      <div class="variant-card-head"><div><span class="network-logo ${meta.logoClass}">${meta.logo}</span><span><strong>${escapeHtml(meta.label)}</strong><small>${variant ? (variant.generated ? 'Versão automática — editável' : 'Versão personalizada') : 'Usando conteúdo principal'}</small></span></div><label class="variant-toggle"><input type="checkbox" data-variant-toggle="${platform}" ${variant ? 'checked' : ''}/><span>Personalizar</span></label></div>
      <div class="variant-fields ${variant ? '' : 'disabled'}">${titleField}<label class="field compact-field"><span class="field-label"><b>${escapeHtml(rules.captionLabel || 'Texto')}</b><em>${effective.caption.length}/${maxCaption}</em></span><textarea rows="5" data-variant-caption="${platform}" maxlength="${maxCaption}" ${variant ? '' : 'disabled'}>${escapeHtml(effective.caption)}</textarea></label></div>
    </article>`;
  }).join('');

  container.querySelectorAll('[data-variant-toggle]').forEach((input) => input.addEventListener('change', () => {
    const platform = input.dataset.variantToggle;
    if (input.checked) {
      const base = { customized: true, generated: false, title: $('title').value.trim(), caption: $('caption').value.trim() };
      state.networkContent[platform] = base;
    } else delete state.networkContent[platform];
    markPlannerDirty();
    renderNetworkVariants();
    refreshUi();
  }));
  container.querySelectorAll('[data-variant-title]').forEach((input) => input.addEventListener('input', () => {
    const platform = input.dataset.variantTitle;
    if (!state.networkContent[platform]) return;
    state.networkContent[platform].title = input.value;
    state.networkContent[platform].generated = false;
    markPlannerDirty();
    const counter = input.closest('.field')?.querySelector('.field-label em');
    if (counter) counter.textContent = `${input.value.length}${input.maxLength > 0 ? `/${input.maxLength}` : ''}`;
    updatePreview();
    renderPreflight();
    updateWizardSummary();
  }));
  container.querySelectorAll('[data-variant-caption]').forEach((input) => input.addEventListener('input', () => {
    const platform = input.dataset.variantCaption;
    if (!state.networkContent[platform]) return;
    state.networkContent[platform].caption = input.value;
    state.networkContent[platform].generated = false;
    markPlannerDirty();
    const counter = input.closest('.field')?.querySelector('.field-label em');
    if (counter) counter.textContent = `${input.value.length}${input.maxLength > 0 ? `/${input.maxLength}` : ''}`;
    updatePreview();
    renderPreflight();
    updateWizardSummary();
  }));
}

function isPublicHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host) || host.endsWith('.local')) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const match172 = host.match(/^172\.(\d+)\./);
    if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

function setKind(kind, { keepFile = false } = {}) {
  state.kind = kind;
  $('mediaKind').value = kind;
  $$('.type-btn').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
  $('mediaSection').classList.toggle('hidden', kind === 'text');
  $('kindBadge').textContent = kind === 'text' ? 'Texto' : kind === 'image' ? 'Imagem' : 'Video';

  const rules = currentRules();
  $$('[data-platform-card]').forEach((card) => {
    const platform = card.dataset.platformCard;
    const supported = rules[platform]?.mediaKinds?.includes(kind);
    const input = card.querySelector('input');
    card.classList.toggle('disabled', !supported);
    input.disabled = !supported;
    if (!supported) input.checked = false;
  });

  if (!keepFile && currentMediaInfo()) clearMedia();
  $('media').accept = kind === 'video' ? 'video/*' : kind === 'image' ? 'image/*' : '';
  $('fileHint').textContent = kind === 'video' ? 'MP4 é o formato mais compatível; também aceitamos outros formatos quando a rede permitir' : 'JPG ou PNG são as opções mais compatíveis';
  if ($('uploadTitle')) $('uploadTitle').textContent = kind === 'video' ? 'Arraste seu vídeo aqui' : 'Arraste sua imagem aqui';
  if ($('mediaSectionTitle')) $('mediaSectionTitle').textContent = kind === 'video' ? 'Adicione seu vídeo' : kind === 'image' ? 'Adicione sua imagem' : 'Adicione sua mídia';
  refreshUi();
}

function setFile(file) {
  if (!file) return;
  renderPublishProgress();
  const inferredKind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
  if (!inferredKind) {
    toast('Selecione uma imagem ou um vídeo.', 'error');
    $('media').value = '';
    return;
  }
  const maxUploadMb = Number(state.config?.maxUploadMb || 0);
  if (maxUploadMb > 0 && file.size > maxUploadMb * 1024 * 1024) {
    toast(`Este arquivo tem ${formatBytes(file.size)}. O limite atual do sistema é ${maxUploadMb} MB.`, 'error');
    $('media').value = '';
    return;
  }
  state.file = file;
  state.plannerExistingMedia = null;
  state.plannerRemoveMedia = false;
  markPlannerDirty();
  if (state.kind !== inferredKind) setKind(inferredKind, { keepFile: true });

  if (state.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  $('emptyUpload').classList.add('hidden');
  $('mediaPreviewWrap').classList.remove('hidden');
  $('clearMediaBtn').classList.remove('hidden');
  $('fileName').textContent = file.name;
  state.mediaMeta = { duration: null, width: null, height: null };
  updateFileMetaLabel();

  const image = $('imagePreview');
  const video = $('videoPreview');
  image.classList.toggle('hidden', inferredKind !== 'image');
  video.classList.toggle('hidden', inferredKind !== 'video');
  if (inferredKind === 'image') {
    image.onload = () => {
      state.mediaMeta.width = image.naturalWidth || null;
      state.mediaMeta.height = image.naturalHeight || null;
      updateFileMetaLabel();
      refreshUi();
    };
    image.src = state.objectUrl;
  }
  if (inferredKind === 'video') {
    video.onloadedmetadata = () => {
      state.mediaMeta.duration = Number.isFinite(video.duration) ? video.duration : null;
      state.mediaMeta.width = video.videoWidth || null;
      state.mediaMeta.height = video.videoHeight || null;
      updateFileMetaLabel();
      refreshUi();
    };
    video.src = state.objectUrl;
  }
  refreshUi();
}

function clearMedia({ markDirty = true } = {}) {
  renderPublishProgress();
  state.file = null;
  if (state.plannerExistingMedia) state.plannerRemoveMedia = true;
  state.plannerExistingMedia = null;
  state.mediaMeta = { duration: null, width: null, height: null };
  $('media').value = '';
  if (state.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  if (markDirty) markPlannerDirty();
  $('imagePreview').removeAttribute('src');
  $('videoPreview').removeAttribute('src');
  $('mediaPreviewWrap').classList.add('hidden');
  $('emptyUpload').classList.remove('hidden');
  $('clearMediaBtn').classList.add('hidden');
  refreshUi();
}

function buildPreflight() {
  const platforms = selectedPlatforms();
  const rules = currentRules();
  const title = $('title').value.trim();
  const caption = $('caption').value.trim();
  const mediaUrl = $('mediaUrl').value.trim();
  const media = currentMediaInfo();
  const mediaFile = state.file || (media ? { type: media.type, size: media.size, name: media.name } : null);
  const checks = [];

  if (!navigator.onLine) {
    checks.push({ status: 'error', title: 'Sem conexão com a internet', detail: 'Reconecte-se antes de salvar, agendar ou publicar.' });
  }
  if (!platforms.length) {
    checks.push({ status: 'error', title: 'Selecione uma rede', detail: 'Escolha ao menos um destino para a publicacao.' });
  }
  if (!title && !caption) {
    checks.push({ status: 'pending', title: 'Conteudo vazio', detail: 'Adicione um titulo ou uma legenda.' });
  }
  if (state.kind !== 'text' && !mediaFile && !mediaUrl) {
    checks.push({ status: 'pending', title: 'Mídia pendente', detail: 'Selecione o arquivo que deseja publicar.' });
  }

  for (const platform of platforms) {
    const meta = networks[platform];
    const rule = rules[platform];
    const connection = state.config?.connections?.[platform];
    const content = contentForPlatform(platform);
    const platformTitle = content.title;
    const platformCaption = content.caption;
    const issues = [];
    if (!platformTitle && !platformCaption) issues.push('esta versão precisa de algum texto');

    if (!rule?.mediaKinds?.includes(state.kind)) issues.push(`formato ${state.kind} nao suportado`);
    if (!state.config?.demoMode && !connection?.connected) issues.push(connection?.expired ? 'token expirado; reconecte a conta' : 'conta ainda nao conectada');

    if (platform === 'youtube') {
      if (!state.config?.demoMode && !mediaFile) issues.push('precisa do arquivo de video local');
      if (platformTitle.length > Number(rule.titleMax || 100)) issues.push('titulo acima do limite');
      if (new TextEncoder().encode(platformCaption).length > Number(rule.descriptionMaxBytes || 5000)) issues.push('descricao acima do limite');
    }
    if (platform === 'instagram') {
      if (platformCaption.length > Number(rule.captionMax || 2200)) issues.push('legenda acima de 2200 caracteres');
      if (state.kind === 'image' && mediaFile && !(rule.imageMimeTypes || ['image/jpeg']).includes(mediaFile.type)) issues.push('imagem deve ser JPEG');
      if (state.kind === 'video' && mediaFile) {
        const allowed = rule.videoMimeTypes || ['video/mp4', 'video/quicktime'];
        if (!allowed.includes(mediaFile.type)) issues.push('Reel deve ser MP4 ou MOV');
        if (mediaFile.size > Number(rule.videoMaxBytes || 300 * 1024 * 1024)) issues.push('Reel passa de 300 MB');
        if (state.mediaMeta.duration && state.mediaMeta.duration < Number(rule.videoDurationMinSec || 3)) issues.push('Reel tem menos de 3 s');
        if (state.mediaMeta.duration && state.mediaMeta.duration > Number(rule.videoDurationMaxSec || 900)) issues.push('Reel passa de 15 min');
        if (state.mediaMeta.width && state.mediaMeta.width > Number(rule.videoMaxWidth || 1920)) issues.push('largura passa de 1920 px');
      }
      if (!state.config?.demoMode) {
        if (mediaUrl) {
          if (!isPublicHttpUrl(mediaUrl)) issues.push('URL da midia nao e publica');
        } else if (mediaFile && !state.config?.publicBaseIsPublic) {
          issues.push('PUBLIC_BASE_URL ainda aponta para localhost/rede privada');
        } else if (!mediaFile) {
          issues.push('precisa de imagem/video por URL publica');
        }
      }
    }
    if (platform === 'linkedin') {
      if (!state.config?.demoMode && state.kind !== 'text' && !mediaFile) issues.push('imagem/video precisa do arquivo local');
      if (platformCaption.length > Number(rule.commentaryMax || 3000)) issues.push('texto acima do limite');
      if (state.kind === 'image' && mediaFile) {
        const allowed = rule.imageMimeTypes || ['image/jpeg', 'image/png', 'image/gif'];
        if (!allowed.includes(mediaFile.type)) issues.push('imagem deve ser JPG, PNG ou GIF');
      }
      if (state.kind === 'video' && mediaFile) {
        const allowed = rule.videoMimeTypes || ['video/mp4'];
        if (!allowed.includes(mediaFile.type)) issues.push('video deve ser MP4');
        if (mediaFile.size < Number(rule.videoMinBytes || 75 * 1024)) issues.push('video menor que 75 KB');
        if (mediaFile.size > Number(rule.videoMaxBytes || 500 * 1024 * 1024)) issues.push('video passa de 500 MB');
        if (state.mediaMeta.duration && state.mediaMeta.duration < Number(rule.videoDurationMinSec || 3)) issues.push('video tem menos de 3 s');
        if (state.mediaMeta.duration && state.mediaMeta.duration > Number(rule.videoDurationMaxSec || 1800)) issues.push('video passa de 30 min');
      }
    }
    if (platform === 'tiktok') {
      if (state.kind === 'video') {
        if (!state.config?.demoMode && !mediaFile) issues.push('video precisa do arquivo local');
        if (mediaFile) {
          const allowed = rule.videoMimeTypes || ['video/mp4', 'video/quicktime', 'video/webm'];
          if (!allowed.includes(mediaFile.type)) issues.push('video deve ser MP4, MOV ou WebM');
          if (mediaFile.size > Number(rule.videoMaxBytes || 4 * 1024 ** 3)) issues.push('video passa de 4 GB');
          if (state.mediaMeta.width && (state.mediaMeta.width < Number(rule.videoMinWidth || 360) || state.mediaMeta.width > Number(rule.videoMaxWidth || 4096))) issues.push('largura fora da faixa 360–4096 px');
          const maxDuration = Number(state.tiktokCreator?.max_video_post_duration_sec || 0);
          if (maxDuration && state.mediaMeta.duration && state.mediaMeta.duration > maxDuration) issues.push(`video passa do limite desta conta (${maxDuration}s)`);
        }
        if (platformCaption.length > Number(rule.captionMax || 2200)) issues.push('legenda acima de 2200 caracteres');
      }
      if (state.kind === 'image') {
        if (mediaFile) {
          const allowedImages = rule.imageMimeTypes || ['image/jpeg', 'image/webp'];
          if (!allowedImages.includes(mediaFile.type)) issues.push('foto deve ser JPEG ou WebP');
          if (mediaFile.size > Number(rule.imageMaxBytes || 20 * 1024 * 1024)) issues.push('foto passa de 20 MB');
          if (state.mediaMeta.width && state.mediaMeta.height && Math.max(state.mediaMeta.width, state.mediaMeta.height) > Number(rule.imageMaxDimension || 1080)) issues.push('foto passa de 1080p');
        }
        if (platformCaption.length > Number(rule.photoDescriptionMax || 4000)) issues.push('descricao acima de 4000 caracteres');
        if (!state.config?.demoMode) {
          const verifiedBase = state.settings?.tiktok?.verifiedMediaBaseUrl || '';
          const candidate = mediaUrl || (mediaFile && state.config?.publicBaseUrl ? `${state.config.publicBaseUrl}/uploads/arquivo` : '');
          if (mediaUrl && !isPublicHttpUrl(mediaUrl)) issues.push('URL da foto nao e publica');
          if (!mediaUrl && mediaFile && !state.config?.publicBaseIsPublic) issues.push('URL publica de midia ainda aponta para localhost');
          if (!verifiedBase) issues.push('configure o prefixo de URL verificado no TikTok');
          else if (mediaUrl && !mediaUrl.startsWith(`${verifiedBase.replace(/\/+$/, '')}/`) && mediaUrl !== verifiedBase.replace(/\/+$/, '')) issues.push('URL da foto nao pertence ao prefixo verificado no TikTok');
          if (!candidate) issues.push('foto precisa de URL HTTPS verificada');
        }
      }
      if (!$('tiktokPrivacy').value) issues.push('selecione manualmente a privacidade do TikTok');
      if (!$('tiktokConsent').checked) issues.push('confirme o consentimento de publicação no TikTok');
      if ($('tiktokCommercial').checked && !$('tiktokBrandOrganic').checked && !$('tiktokBrandContent').checked) {
        issues.push('marque Minha marca e/ou Parceria paga no conteúdo promocional');
      }
    }
    if (platform === 'facebook') {
      if (state.kind === 'image' && !state.config?.demoMode) {
        if (mediaUrl && !isPublicHttpUrl(mediaUrl)) issues.push('URL da imagem nao e publica');
        else if (!mediaUrl && mediaFile && !state.config?.publicBaseIsPublic) issues.push('URL publica de midia ainda aponta para localhost');
        else if (!mediaUrl && !mediaFile) issues.push('imagem precisa de URL publica');
      }
      if (state.kind === 'video' && mediaFile) {
        if (state.mediaMeta.duration && state.mediaMeta.duration < Number(rule.reelDurationMinSec || 3)) issues.push('Reel tem menos de 3 s');
        if (state.mediaMeta.duration && state.mediaMeta.duration > Number(rule.reelDurationMaxSec || 90)) issues.push('Reel passa de 90 s');
        if (state.mediaMeta.width && state.mediaMeta.height) {
          if (state.mediaMeta.width < Number(rule.reelMinWidth || 540) || state.mediaMeta.height < Number(rule.reelMinHeight || 960)) issues.push('Reel abaixo de 540x960');
          const ratio = state.mediaMeta.width / state.mediaMeta.height;
          if (Math.abs(ratio - 9 / 16) > 0.03) issues.push('Reel precisa ser aproximadamente 9:16');
        }
      } else if (state.kind === 'video' && !state.config?.demoMode && !mediaFile) issues.push('Reel precisa do arquivo local');
    }
    if (platform === 'googleBusiness' && state.kind === 'image' && !state.config?.demoMode) {
      if (mediaUrl && !isPublicHttpUrl(mediaUrl)) issues.push('URL da foto nao e publica');
      else if (!mediaUrl && mediaFile && !state.config?.publicBaseIsPublic) issues.push('URL publica de midia ainda aponta para localhost');
      else if (!mediaUrl && !mediaFile) issues.push('foto precisa de URL publica');
    }

    checks.push({
      platform,
      status: issues.length ? 'error' : 'ok',
      title: meta.label,
      detail: issues.length ? issues.join(' · ') : state.config?.demoMode ? 'Pronto para simulacao em Demo.' : 'Formato, fonte e conexao prontos.',
    });
  }

  return checks;
}

function friendlyIssue(issue) {
  const value = String(issue || '');
  const lower = value.toLowerCase();
  if (lower.includes('conta ainda nao conectada') || lower.includes('conta ainda não conectada')) return 'Conecte esta conta antes de publicar.';
  if (lower.includes('token expirado') || lower.includes('reconecte a conta')) return 'A conexão expirou. Reconecte a conta para continuar.';
  if (lower.includes('public_base_url') || lower.includes('localhost') || lower.includes('rede privada')) return 'A entrega de mídia desta rede ainda precisa ser concluída pelo administrador.';
  if (lower.includes('prefixo') && lower.includes('tiktok')) return 'A publicação de fotos no TikTok ainda precisa de uma configuração do administrador.';
  if (lower.includes('url') && (lower.includes('publica') || lower.includes('pública') || lower.includes('https'))) return 'A mídia ainda não está disponível no formato de entrega exigido por esta rede. Peça ao administrador para revisar a integração.';
  if (lower.includes('selecione manualmente a privacidade') || lower.includes('selecione a privacidade')) return 'Escolha quem poderá ver a publicação.';
  if (lower.includes('consentimento')) return 'Confirme o envio ao TikTok antes de publicar.';
  if (lower.includes('minha marca') || lower.includes('parceria paga')) return 'Informe se o conteúdo promocional é da sua marca e/ou uma parceria paga.';
  if (lower.includes('formato') && lower.includes('nao suportado')) return 'Este formato não pode ser publicado nesta rede.';
  if (lower.includes('precisa do arquivo') || lower.includes('arquivo local')) return 'Selecione o arquivo que será publicado.';
  if (lower.includes('versão precisa') || lower.includes('versao precisa')) return 'Adicione texto para esta versão da rede ou volte a usar o conteúdo principal.';
  if (lower.includes('acima') || lower.includes('passa de') || lower.includes('menor') || lower.includes('menos de') || lower.includes('fora da faixa') || lower.includes('abaixo de')) return `Revise a mídia ou o texto: ${value}.`;
  return value;
}

function friendlyCheckDetail(check) {
  if (!check?.detail) return '';
  return String(check.detail).split(' · ').map(friendlyIssue).filter(Boolean).join(' ');
}

function renderPreflight() {
  const checks = buildPreflight();
  const list = $('preflightList');
  if (!list) return;
  list.innerHTML = checks.map((check) => {
    const icon = check.status === 'ok' ? '✓' : check.status === 'error' ? '!' : '…';
    const network = check.platform ? `<span class="preflight-logo ${networks[check.platform].logoClass}">${networks[check.platform].logo}</span>` : `<span class="preflight-logo generic">${icon}</span>`;
    const friendly = check.status === 'ok' ? (check.platform ? 'Pronto para publicar nesta rede.' : friendlyCheckDetail(check)) : friendlyCheckDetail(check);
    const showTechnical = check.status !== 'ok' && friendly && friendly !== check.detail;
    const technical = showTechnical ? `<details class="technical-detail"><summary>Ver detalhe técnico</summary><code>${escapeHtml(check.detail)}</code></details>` : '';
    return `<div class="preflight-item ${check.status}">${network}<div><strong>${escapeHtml(check.title)}</strong><small>${escapeHtml(friendly)}</small>${technical}</div><span class="preflight-state">${icon}</span></div>`;
  }).join('');

  const errors = checks.filter((item) => item.status === 'error').length;
  const pending = checks.filter((item) => item.status === 'pending').length;
  const summary = $('preflightSummary');
  if (errors) {
    summary.textContent = `${errors} ajuste${errors > 1 ? 's' : ''}`;
    summary.className = 'chip danger';
    if ($('readinessTitle')) $('readinessTitle').textContent = `Precisamos corrigir ${errors} ${errors > 1 ? 'coisas' : 'coisa'}`;
  } else if (pending) {
    summary.textContent = `${pending} pendência${pending > 1 ? 's' : ''}`;
    summary.className = 'chip warning';
    if ($('readinessTitle')) $('readinessTitle').textContent = 'Falta concluir a publicação';
  } else {
    summary.textContent = 'Tudo certo';
    summary.className = 'chip success';
    if ($('readinessTitle')) $('readinessTitle').textContent = 'Tudo pronto para publicar';
  }

  const hardBlock = errors > 0 || pending > 0 || state.publishing;
  $('publishBtn').disabled = hardBlock;
}

function updatePreviewPlatformTabs() {
  const container = $('previewPlatformTabs');
  if (!container) return;
  const platforms = selectedPlatforms();
  if (!platforms.length) {
    state.previewPlatform = null;
    container.innerHTML = '<span class="preview-tabs-empty">Selecione uma rede para visualizar a prévia.</span>';
    return;
  }
  if (!platforms.includes(state.previewPlatform)) state.previewPlatform = platforms[0];
  container.innerHTML = platforms.map((platform) => `<button type="button" class="preview-platform-tab ${platform === state.previewPlatform ? 'active' : ''}" data-preview-platform="${platform}"><span class="mini-network ${networks[platform].logoClass}">${networks[platform].logo}</span>${escapeHtml(networks[platform].label)}</button>`).join('');
}

function updatePreview() {
  updatePreviewPlatformTabs();
  const platform = state.previewPlatform;
  const previewContent = platform ? contentForPlatform(platform) : { title: $('title').value.trim(), caption: $('caption').value.trim() };
  const title = previewContent.title;
  const caption = previewContent.caption;
  const connection = platform ? state.config?.connections?.[platform] : null;
  const meta = platform ? networks[platform] : null;

  if ($('previewAvatar')) {
    $('previewAvatar').className = `avatar ${meta?.logoClass || ''}`.trim();
    $('previewAvatar').textContent = meta?.logo || 'SP';
  }
  if ($('previewAccountName')) $('previewAccountName').textContent = connection?.name || (meta ? `${meta.label} conectado` : 'Seu perfil');
  if ($('previewNetworkName')) $('previewNetworkName').textContent = meta ? `Prévia para ${meta.label}` : 'Prévia da publicação';

  const showSeparateTitle = platform === 'youtube';
  $('previewTitle').classList.toggle('hidden', !showSeparateTitle);
  $('previewTitle').textContent = title || (showSeparateTitle ? 'Título do vídeo' : '');
  $('previewCaption').textContent = caption || (!showSeparateTitle && title ? title : 'A legenda da publicação aparece aqui conforme você escreve.');

  const previewMedia = $('previewMedia');
  if (state.objectUrl && state.kind === 'image') {
    previewMedia.className = 'preview-media';
    previewMedia.innerHTML = `<img src="${state.objectUrl}" alt="Preview" />`;
  } else if (state.objectUrl && state.kind === 'video') {
    previewMedia.className = 'preview-media';
    previewMedia.innerHTML = `<video src="${state.objectUrl}" muted autoplay loop playsinline></video>`;
  } else if (state.kind === 'text') {
    previewMedia.className = 'preview-media text-only hidden';
    previewMedia.innerHTML = '';
  } else {
    previewMedia.className = 'preview-media empty';
    previewMedia.innerHTML = '<span>Adicione a mídia para visualizar</span>';
  }

  const platforms = selectedPlatforms();
  $('previewNetworks').innerHTML = platforms.length
    ? platforms.map((item) => `<span class="mini-network ${networks[item].logoClass}" title="${networks[item].label}">${networks[item].logo}</span>`).join('')
    : '<span class="preview-none">Nenhuma rede selecionada</span>';
}

function updateCounters() {
  const titleLength = $('title').value.length;
  const captionLength = $('caption').value.length;
  $('titleCount').textContent = `${titleLength}/100`;
  $('captionCount').textContent = `${captionLength}/3000`;
  $('titleCount').classList.toggle('near-limit', titleLength >= 90);
  $('captionCount').classList.toggle('near-limit', captionLength >= 2700);
}

function updateNetworkAvailability() {
  const rules = currentRules();
  let compatibleCount = 0;
  let availableCount = 0;
  $$('[data-platform-card]').forEach((card) => {
    const platform = card.dataset.platformCard;
    const input = card.querySelector('input');
    const supportsKind = Boolean(rules[platform]?.mediaKinds?.includes(state.kind));
    const connection = state.config?.connections?.[platform] || {};
    const availableConnection = Boolean(state.config?.demoMode || (connection.connected && !connection.expired && !connection.needsReconnect));
    if (supportsKind) compatibleCount += 1;
    if (supportsKind && availableConnection) availableCount += 1;
    const disabled = !supportsKind || (state.config && !availableConnection);
    input.disabled = disabled;
    card.classList.toggle('disabled', disabled);
    card.classList.toggle('not-connected', supportsKind && state.config && !availableConnection);
    if (disabled) input.checked = false;

    const label = document.querySelector(`[data-network-availability="${platform}"]`);
    if (!label) return;
    if (!supportsKind) {
      label.textContent = `Não disponível para ${state.kind === 'text' ? 'texto' : state.kind === 'image' ? 'imagem' : 'vídeo'}`;
      label.className = 'availability unavailable';
    } else if (!state.config) {
      label.textContent = 'Verificando conta...';
      label.className = 'availability';
    } else if (state.config.demoMode) {
      label.textContent = 'Disponível no modo Demo';
      label.className = 'availability available';
    } else if (connection.connected) {
      label.textContent = connection.name || 'Conta conectada';
      label.className = 'availability available';
    } else if (connection.expired || connection.needsReconnect) {
      label.textContent = 'Conexão expirada — reconecte';
      label.className = 'availability unavailable';
    } else if (connection.configured) {
      label.textContent = 'Conta ainda não conectada';
      label.className = 'availability unavailable';
    } else {
      label.textContent = 'Integração ainda não configurada';
      label.className = 'availability unavailable';
    }
  });

  const help = document.querySelector('.network-selection-help');
  if (help && state.config) {
    const title = help.querySelector('strong');
    const copy = help.querySelector('p');
    const action = help.querySelector('[data-go-page="connections"]');
    const noAvailable = !state.config.demoMode && compatibleCount > 0 && availableCount === 0;
    help.classList.toggle('attention', noAvailable);
    if (noAvailable) {
      title.textContent = 'Nenhuma conta disponível para este formato';
      copy.textContent = 'Conecte ou reconecte pelo menos uma das redes compatíveis para continuar.';
      if (action) action.textContent = 'Resolver conexões';
    } else {
      title.textContent = 'Compatibilidade automática';
      copy.textContent = 'Uma rede pode aparecer indisponível quando não aceita o formato escolhido ou quando a conta ainda não está conectada.';
      if (action) action.textContent = 'Gerenciar contas';
    }
  }
}

function renderAdjustments() {
  const platforms = selectedPlatforms();
  $$('[data-adjustment-card]').forEach((card) => card.classList.toggle('hidden', !platforms.includes(card.dataset.adjustmentCard)));
  if ($('adjustmentCount')) $('adjustmentCount').textContent = `${platforms.length} rede${platforms.length === 1 ? '' : 's'}`;
  if ($('youtubeOptions')) $('youtubeOptions').classList.toggle('hidden', !platforms.includes('youtube'));
  if ($('tiktokOptions')) $('tiktokOptions').classList.toggle('hidden', !platforms.includes('tiktok'));
  renderNetworkVariants();
}

function updateNetworkState() {
  const count = selectedPlatforms().length;
  $('publishDestinations').textContent = `${count} rede${count === 1 ? '' : 's'}`;
  renderAdjustments();
}

function updateWizardSummary() {
  if (!$('summaryKind')) return;
  const kindLabel = state.kind === 'text' ? 'Texto' : state.kind === 'image' ? 'Imagem' : 'Vídeo';
  const kindIcon = state.kind === 'text' ? '≡' : state.kind === 'image' ? '▧' : '▶';
  $('summaryKind').textContent = kindLabel;
  $('summaryKindIcon').textContent = kindIcon;
  const summaryMedia = currentMediaInfo();
  $('summaryMedia').textContent = state.kind === 'text' ? 'Sem mídia' : summaryMedia ? `${summaryMedia.name} · ${formatBytes(summaryMedia.size)}` : 'Arquivo ainda não selecionado';
  $('summaryTitle').textContent = $('title').value.trim() || 'Ainda sem título';
  const caption = $('caption').value.trim();
  $('summaryCaption').textContent = caption ? (caption.length > 120 ? `${caption.slice(0, 120)}…` : caption) : 'Escreva a legenda para visualizar o resumo.';
  const platforms = selectedPlatforms();
  $('summaryNetworks').innerHTML = platforms.length
    ? platforms.map((platform) => `<span class="summary-network"><span class="mini-network ${networks[platform].logoClass}">${networks[platform].logo}</span>${escapeHtml(networks[platform].label)}</span>`).join('')
    : '<small>Nenhuma rede selecionada</small>';
  const tips = {
    1: ['1', 'Monte o conteúdo e selecione o arquivo quando houver mídia.'],
    2: ['2', 'Escolha uma ou mais redes disponíveis para este formato.'],
    3: ['3', 'Revise somente os ajustes que cada plataforma exige.'],
    4: ['✓', 'Confira o checklist. Se estiver tudo certo, é só publicar.'],
  };
  const [badge, text] = tips[state.publishStep] || tips[1];
  $('summaryTip').innerHTML = `<span>${badge}</span><p>${text}</p>`;
}

function validateWizardStep(step, { quiet = false } = {}) {
  let message = '';
  if (step === 1) {
    if (!$('title').value.trim() && !$('caption').value.trim()) message = 'Adicione um título ou escreva o texto da publicação.';
    else if (state.kind !== 'text' && !currentMediaInfo()) message = `Selecione ${state.kind === 'image' ? 'a imagem' : 'o vídeo'} que deseja publicar.`;
  }
  if (step === 2 && !selectedPlatforms().length) message = 'Selecione pelo menos uma rede para continuar.';
  if (step === 3 && selectedPlatforms().includes('tiktok')) {
    if (!$('tiktokPrivacy').value) message = 'Escolha quem poderá ver a publicação no TikTok.';
    else if ($('tiktokCommercial').checked && !$('tiktokBrandOrganic').checked && !$('tiktokBrandContent').checked) message = 'No conteúdo promocional do TikTok, marque Minha marca e/ou Parceria paga.';
    else if (!$('tiktokConsent').checked) message = 'Confirme o envio ao TikTok para continuar.';
  }
  if (message && !quiet) toast(message, 'error');
  return !message;
}

function setPublishStep(step, { force = false } = {}) {
  const target = Math.max(1, Math.min(4, Number(step) || 1));
  if (!force && target > state.publishStep) {
    for (let current = state.publishStep; current < target; current += 1) {
      if (!validateWizardStep(current)) return false;
    }
  }
  state.publishStep = target;
  state.maxPublishStep = Math.max(state.maxPublishStep, target);
  $$('.wizard-step').forEach((node) => node.classList.toggle('active', Number(node.dataset.publishStep) === target));
  $$('[data-publish-step-target]').forEach((button) => {
    const buttonStep = Number(button.dataset.publishStepTarget);
    button.classList.toggle('active', buttonStep === target);
    button.classList.toggle('complete', buttonStep < target || buttonStep < state.maxPublishStep);
    button.disabled = buttonStep > state.maxPublishStep;
  });
  $('publish')?.classList.toggle('review-mode', target === 4);
  updateWizardSummary();
  if (target === 4) refreshUi();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

function resultTechnicalMeta(result = {}) {
  const parts = [];
  if (result.code) parts.push(`<span><b>Codigo:</b> ${escapeHtml(result.code)}</span>`);
  if (result.reason && result.reason !== result.code) parts.push(`<span><b>Motivo:</b> ${escapeHtml(result.reason)}</span>`);
  if (result.apiStatus) parts.push(`<span><b>Status API:</b> ${escapeHtml(result.apiStatus)}</span>`);
  if (result.apiCode) parts.push(`<span><b>Codigo API:</b> ${escapeHtml(result.apiCode)}</span>`);
  if (result.logId) parts.push(`<span><b>Log ID:</b> ${escapeHtml(result.logId)}</span>`);
  if (result.requestId) parts.push(`<span><b>Request ID:</b> ${escapeHtml(result.requestId)}</span>`);
  if (result.publishId) parts.push(`<span><b>Publish ID:</b> ${escapeHtml(result.publishId)}</span>`);
  if (result.attemptId) parts.push(`<span><b>ID interno:</b> ${escapeHtml(result.attemptId)}</span>`);
  if (result.stage) parts.push(`<span><b>Etapa:</b> ${escapeHtml(result.stage)}</span>`);
  if (result.httpStatus) parts.push(`<span><b>HTTP:</b> ${escapeHtml(result.httpStatus)}</span>`);
  return parts.join('');
}

function resultTechnicalText(result = {}) {
  const lines = [];
  if (result.message) lines.push(`Mensagem: ${result.message}`);
  if (result.code) lines.push(`Codigo: ${result.code}`);
  if (result.reason && result.reason !== result.code) lines.push(`Motivo: ${result.reason}`);
  if (result.apiStatus) lines.push(`Status API: ${result.apiStatus}`);
  if (result.apiCode) lines.push(`Codigo API: ${result.apiCode}`);
  if (result.logId) lines.push(`Log ID: ${result.logId}`);
  if (result.requestId) lines.push(`Request ID: ${result.requestId}`);
  if (result.publishId) lines.push(`Publish ID: ${result.publishId}`);
  if (result.attemptId) lines.push(`ID interno: ${result.attemptId}`);
  if (result.stage) lines.push(`Etapa: ${result.stage}`);
  if (result.httpStatus) lines.push(`HTTP: ${result.httpStatus}`);
  return lines.join('\n');
}

function renderPublishProgress(results = null, running = false) {
  const container = $('publishProgress');
  if (!container) return;
  const platforms = selectedPlatforms();
  if (!running && !results) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = `<div class="publish-progress-head"><strong>${running ? 'Publicando seu conteúdo' : 'Resultado da publicação'}</strong><small>${running ? 'Aguarde enquanto enviamos para cada rede.' : 'Confira o resultado de cada destino.'}</small></div><div class="publish-progress-list">${platforms.map((platform) => {
    const result = results?.[platform];
    const status = running && !result ? 'pending' : result?.status === 'success' ? 'success' : result?.status === 'error' ? 'error' : 'pending';
    const label = status === 'success' ? 'Publicado' : status === 'error' ? 'Falhou' : 'Publicando...';
    const icon = status === 'success' ? '✓' : status === 'error' ? '!' : '◌';
    const technical = status === 'error' ? resultTechnicalMeta(result) : '';
    return `<div class="publish-progress-row ${status}"><span class="network-logo ${networks[platform].logoClass}">${networks[platform].logo}</span><div><strong>${networks[platform].label}</strong><small>${result?.message ? escapeHtml(result.message) : label}</small>${technical ? `<div class="publish-error-meta">${technical}</div>` : ''}</div><span class="progress-state">${icon}</span></div>`;
  }).join('')}</div>`;
}

function refreshUi() {
  updateNetworkAvailability();
  updateCounters();
  updateNetworkState();
  updateWizardSummary();
  updatePreview();
  renderPreflight();
}

function formatRelativeExpiry(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor(abs / 3600000);
  const minutes = Math.max(1, Math.floor(abs / 60000));
  const amount = days > 0 ? `${days} dia${days === 1 ? '' : 's'}` : hours > 0 ? `${hours}h` : `${minutes} min`;
  return diff < 0 ? `Expirou há ${amount}` : `Autorização válida por mais ${amount}`;
}

function connectionView(platform, connection = {}) {
  const demo = Boolean(state.config?.demoMode);
  const connected = Boolean(connection.connected);
  const expired = Boolean(connection.expired);
  const configured = Boolean(connection.configured);
  const needsReconnect = Boolean(connection.needsReconnect);

  if (demo && !connected) {
    return {
      status: 'Disponível em Demo', statusClass: 'success', tone: 'demo',
      description: 'O sistema pode simular publicações nesta rede sem conectar uma conta.',
    };
  }
  if (expired || needsReconnect) {
    return {
      status: 'Precisa reconectar', statusClass: 'danger', tone: 'attention',
      description: 'A autorização desta conta precisa ser renovada antes de publicar.',
    };
  }
  if (connected) {
    return {
      status: 'Conectado', statusClass: 'success', tone: 'connected',
      description: 'Conta pronta para receber novas publicações.',
    };
  }
  if (configured) {
    return {
      status: 'Pronto para conectar', statusClass: 'warning', tone: 'ready',
      description: 'A integração está pronta. Falta apenas escolher a conta que será usada.',
    };
  }
  return {
    status: 'Configuração pendente', statusClass: 'neutral', tone: 'setup',
    description: 'Um administrador ainda precisa concluir a configuração desta integração.',
  };
}

function renderConnectionTarget(platform, connection) {
  if (platform === 'facebook' && connection.connected && Array.isArray(connection.pages) && connection.pages.length) {
    const options = connection.pages.map((page) => `<option value="${escapeHtml(page.id)}" ${page.id === connection.selectedPageId ? 'selected' : ''}>${escapeHtml(page.name || page.id)}</option>`).join('');
    return `<label class="connection-target"><span>Página usada para publicar</span><select data-connection-target="facebook">${options}</select></label>`;
  }
  if (platform === 'googleBusiness' && connection.connected && Array.isArray(connection.locations) && connection.locations.length) {
    const options = connection.locations.map((location) => `<option value="${escapeHtml(location.name)}" ${location.name === connection.selectedLocationName ? 'selected' : ''}>${escapeHtml(location.title || location.name)}</option>`).join('');
    return `<label class="connection-target"><span>Unidade usada para publicar</span><select data-connection-target="googleBusiness">${options}</select></label>`;
  }
  return '';
}

function renderConnectionsSummary() {
  const node = $('connectionsSummary');
  if (!node || !state.config) return;
  const entries = Object.entries(networks);
  const connected = entries.filter(([platform]) => { const item = state.config.connections?.[platform] || {}; return item.connected && !item.expired && !item.needsReconnect; }).length;
  const attention = entries.filter(([platform]) => {
    const item = state.config.connections?.[platform] || {};
    return item.expired || item.needsReconnect;
  }).length;
  const ready = entries.filter(([platform]) => {
    const item = state.config.connections?.[platform] || {};
    return !item.connected && !item.expired && !item.needsReconnect && item.configured;
  }).length;
  const headline = state.config.demoMode ? 'Modo Demo ativo' : connected ? `${connected} de ${entries.length} redes conectadas` : 'Nenhuma rede conectada';
  const detail = state.config.demoMode
    ? 'Você pode testar o fluxo sem contas reais. As conexões abaixo continuam disponíveis para configuração.'
    : attention
      ? `${attention} conta(s) precisam de atenção.`
      : connected
        ? 'As contas conectadas estão prontas para uso.'
        : ready
          ? `${ready} integração(ões) já estão prontas para conectar uma conta.`
          : 'Um administrador precisa configurar uma integração antes da primeira conexão.';
  node.innerHTML = `<div><span class="connections-summary-icon">◎</span><p><strong>${headline}</strong><small>${detail}</small></p></div><div class="connections-summary-pills"><span><b>${connected}</b> conectadas</span><span><b>${ready}</b> prontas para conectar</span>${attention ? `<span class="attention"><b>${attention}</b> atenção</span>` : ''}</div>`;
}

async function saveConnectionTarget(platform, value, select) {
  if (!value) return;
  const previous = select.dataset.previousValue || '';
  select.disabled = true;
  try {
    const response = await apiFetch(`api/connections/${platform}/target`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível alterar o destino.');
    select.dataset.previousValue = value;
    if (platform === 'facebook' && state.settings?.facebook) state.settings.facebook.pageId = value;
    if (platform === 'googleBusiness' && state.settings?.googleBusiness) state.settings.googleBusiness.locationName = value;
    toast(platform === 'facebook' ? 'Página de destino atualizada.' : 'Unidade de destino atualizada.', 'success');
    loadConfig().catch(() => toast('Destino atualizado, mas o status não pôde ser recarregado agora.', 'error'));
  } catch (error) {
    if (previous) select.value = previous;
    toast(error.message, 'error');
  } finally {
    select.disabled = false;
  }
}

function renderConnections() {
  const grid = $('connectionsGrid');
  if (!grid || !state.config) return;
  renderConnectionsSummary();
  grid.innerHTML = Object.entries(networks).map(([platform, meta]) => {
    const connection = state.config.connections?.[platform] || {};
    const view = connectionView(platform, connection);
    const connected = Boolean(connection.connected && !connection.expired && !connection.needsReconnect);
    const configured = Boolean(connection.configured);
    const canConnect = configured;
    const accountName = connection.name || (state.config.demoMode ? 'Nenhuma conta exigida para simulação' : 'Nenhuma conta vinculada');
    const expiry = connection.expiresAt ? formatRelativeExpiry(connection.expiresAt) : '';
    const target = renderConnectionTarget(platform, connection);

    let actions = '';
    if (connected) {
      actions = `<a class="connection-action primary" href="${meta.auth}">Reconectar</a><button class="connection-action subtle-danger" data-disconnect="${platform}" type="button">Desconectar</button>`;
    } else if (canConnect) {
      actions = `<a class="connection-action primary" href="${meta.auth}">${connection.expired || connection.needsReconnect ? 'Reconectar conta' : 'Conectar conta'}</a>`;
    } else {
      actions = state.canAdmin
        ? `<button class="connection-action secondary" data-go-page="admin" data-configure-platform="${platform}" type="button">Configurar integração</button>`
        : '<span class="connection-admin-note">Aguardando configuração do administrador</span>';
    }

    return `<article class="connection-card ${view.tone}">
      <div class="connection-card-head">
        <span class="connection-logo ${meta.logoClass}">${meta.logo}</span>
        <span class="status-tag ${view.statusClass}"><i></i>${view.status}</span>
      </div>
      <div class="connection-identity"><h3>${meta.label}</h3><strong>${escapeHtml(accountName)}</strong><p>${escapeHtml(view.description)}</p></div>
      ${expiry ? `<div class="connection-expiry ${connection.expired ? 'expired' : ''}"><span>◷</span>${escapeHtml(expiry)}</div>` : ''}
      ${target}
      <div class="connection-actions">${actions}</div>
    </article>`;
  }).join('');

  $$('[data-disconnect]').forEach((button) => button.addEventListener('click', async () => {
    const platform = button.dataset.disconnect;
    if (!window.confirm(`Desconectar ${networks[platform].label}? Você precisará autorizar a conta novamente para publicar.`)) return;
    button.disabled = true;
    const response = await apiFetch(`api/connections/${platform}`, { method: 'DELETE' });
    if (!response.ok) {
      button.disabled = false;
      return toast('Não foi possível desconectar a conta.', 'error');
    }
    toast(`${networks[platform].label} desconectado.`, 'success');
    loadConfig().catch(() => toast('Conta desconectada, mas a lista não pôde ser atualizada agora.', 'error'));
  }));

  $$('[data-connection-target]').forEach((select) => {
    select.dataset.previousValue = select.value;
    select.addEventListener('change', () => saveConnectionTarget(select.dataset.connectionTarget, select.value, select));
  });
}

function renderMetrics() {
  if (!state.config) return;
  const connections = Object.values(state.config.connections || {});
  const total = Object.keys(networks).length;
  const connected = state.config.demoMode ? total : connections.filter((item) => item.connected && !item.expired && !item.needsReconnect).length;
  const resultItems = state.history.flatMap((entry) => Object.values(entry.results || {}));
  const successfulResults = resultItems.filter((result) => result.status === 'success').length;
  const successRate = resultItems.length ? Math.round((successfulResults / resultItems.length) * 100) : null;
  const connectionAttention = state.config.demoMode ? 0 : connections.filter((item) => !item.connected || item.expired || item.needsReconnect).length;
  const publicationAttention = state.history.filter((entry) => Object.values(entry.results || {}).some((result) => result.status === 'error')).length;
  const plannerAttention = state.planner.filter((item) => ['failed', 'partial', 'needs_review'].includes(item.status)).length;

  if ($('connectedMetric')) $('connectedMetric').textContent = `${connected}/${total}`;
  if ($('publishMetric')) $('publishMetric').textContent = state.loadErrors.history ? '--' : String(state.history.length);
  if ($('successMetric')) $('successMetric').textContent = state.loadErrors.history ? '--' : (successRate === null ? '--' : `${successRate}%`);
  if ($('attentionMetric')) $('attentionMetric').textContent = (state.loadErrors.history || state.loadErrors.planner) ? '--' : String(connectionAttention + publicationAttention + plannerAttention);
  renderPlannerNavigationCounts();
  renderDashboard();
}

function renderDashboard() {
  if (!state.config) return;
  renderDashboardUpcoming();
  const networkList = $('dashboardConnections');
  if (networkList) {
    networkList.innerHTML = Object.entries(networks).map(([platform, meta]) => {
      const connection = state.config.connections?.[platform] || {};
      const demo = Boolean(state.config.demoMode);
      const needsAttention = Boolean(connection.expired || connection.needsReconnect);
      const connected = demo || Boolean(connection.connected && !needsAttention);
      const configured = Boolean(connection.configured);
      let label = 'Não disponível';
      let statusClass = 'neutral';
      let detail = 'A integração ainda precisa ser configurada.';
      if (demo) {
        label = 'Disponível em Demo'; statusClass = 'success'; detail = 'Simulação habilitada.';
      } else if (connected) {
        label = 'Conectado'; statusClass = 'success'; detail = connection.name || 'Conta pronta para publicar.';
      } else if (needsAttention) {
        label = 'Reconectar'; statusClass = 'danger'; detail = connection.name || 'A autorização precisa ser renovada.';
      } else if (configured) {
        label = 'Pronto para conectar'; statusClass = 'warning'; detail = 'Integração pronta; falta vincular uma conta.';
      }
      return `<div class="dashboard-network-row">
        <span class="connection-logo ${meta.logoClass}">${meta.logo}</span>
        <div class="dashboard-network-copy"><strong>${meta.label}</strong><small>${escapeHtml(detail)}</small></div>
        <span class="dashboard-status ${statusClass}"><i></i>${label}</span>
      </div>`;
    }).join('');
  }

  const recent = $('dashboardRecent');
  if (!recent) return;
  if (state.loadErrors.history) {
    recent.innerHTML = loadErrorHtml('history', 'Não foi possível carregar as publicações', state.loadErrors.history);
    return;
  }
  if (!state.history.length) {
    recent.innerHTML = `<div class="dashboard-empty">
      <span>▤</span><div><strong>Nenhuma publicação ainda</strong><p>Quando você fizer o primeiro envio, ele aparecerá aqui.</p></div>
      <button type="button" data-go-page="publish">Criar publicação</button>
    </div>`;
    return;
  }

  recent.innerHTML = state.history.slice(0, 5).map((entry) => {
    const results = Object.entries(entry.results || {});
    const errors = results.filter(([, result]) => result.status === 'error').length;
    const successes = results.filter(([, result]) => result.status === 'success').length;
    const statusClass = errors ? 'danger' : 'success';
    const statusText = errors ? `${errors} com problema` : entry.demoMode ? 'Simulado' : 'Publicado';
    const destinationText = results.length ? `${successes}/${results.length} redes concluídas` : 'Sem destinos registrados';
    const title = entry.title || entry.caption?.slice(0, 80) || 'Publicação';
    const logos = results.slice(0, 5).map(([platform]) => `<span class="mini-network ${networks[platform]?.logoClass || ''}" title="${networks[platform]?.label || platform}">${networks[platform]?.logo || '?'}</span>`).join('');
    return `<div class="dashboard-recent-row">
      <span class="dashboard-kind">${entry.mediaKind === 'video' ? '▶' : entry.mediaKind === 'image' ? '▧' : '≡'}</span>
      <div class="dashboard-recent-copy"><strong>${escapeHtml(title)}</strong><small>${formatDate(entry.createdAt)} · ${destinationText}</small></div>
      <div class="dashboard-recent-networks">${logos}</div>
      <span class="dashboard-result ${statusClass}">${statusText}</span>
    </div>`;
  }).join('');
}

function renderPlannerNavigationCounts() {
  const scheduled = state.planner.filter((item) => item.status === 'scheduled').length;
  const drafts = state.planner.filter((item) => ['draft', 'failed', 'partial', 'needs_review'].includes(item.status)).length;
  if ($('scheduledNavCount')) {
    $('scheduledNavCount').textContent = String(scheduled);
    $('scheduledNavCount').classList.toggle('hidden', scheduled === 0);
  }
  if ($('draftNavCount')) {
    $('draftNavCount').textContent = String(drafts);
    $('draftNavCount').classList.toggle('hidden', drafts === 0);
  }
}

function renderDashboardUpcoming() {
  const node = $('dashboardUpcoming');
  if (!node) return;
  if (state.loadErrors.planner) {
    node.innerHTML = loadErrorHtml('planner', 'Não foi possível carregar a agenda', state.loadErrors.planner);
    return;
  }
  const now = Date.now();
  const upcoming = state.planner
    .filter((item) => item.status === 'scheduled' && item.scheduledAt && new Date(item.scheduledAt).getTime() >= now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 5);
  if (!upcoming.length) {
    node.innerHTML = '<div class="dashboard-empty compact"><span>□</span><div><strong>Nada agendado</strong><p>Agende uma publicação para ela aparecer aqui.</p></div><button type="button" data-go-page="publish">Criar conteúdo</button></div>';
    return;
  }
  node.innerHTML = upcoming.map((item) => {
    const title = item.payload?.title || item.payload?.caption?.slice(0, 70) || 'Publicação agendada';
    const platforms = item.payload?.platforms || [];
    const logos = platforms.slice(0, 5).map((platform) => `<span class="mini-network ${networks[platform]?.logoClass || ''}" title="${escapeHtml(networks[platform]?.label || platform)}">${networks[platform]?.logo || '?'}</span>`).join('');
    return `<button class="dashboard-upcoming-row" type="button" data-planner-edit="${escapeHtml(item.id)}"><span class="dashboard-kind">□</span><div><strong>${escapeHtml(title)}</strong><small>${formatDayTime(item.scheduledAt)}</small></div><div class="dashboard-recent-networks">${logos}</div><span class="dashboard-result info">Agendado</span></button>`;
  }).join('');
  bindPlannerDynamicActions(node);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderCalendar() {
  const grid = $('editorialCalendar');
  if (!grid) return;
  if (state.loadErrors.planner) {
    grid.innerHTML = loadErrorHtml('planner', 'Não foi possível carregar o calendário', state.loadErrors.planner);
    if ($('calendarUpcoming')) $('calendarUpcoming').innerHTML = loadErrorHtml('planner', 'Agenda indisponível', state.loadErrors.planner);
    if ($('calendarScheduledMetric')) $('calendarScheduledMetric').textContent = '--';
    if ($('calendarWeekMetric')) $('calendarWeekMetric').textContent = '--';
    if ($('calendarAttentionMetric')) $('calendarAttentionMetric').textContent = '--';
    return;
  }
  const cursor = state.calendarCursor instanceof Date ? state.calendarCursor : new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const formatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
  $('calendarMonthLabel').textContent = formatter.format(first).replace(/^./, (char) => char.toUpperCase());

  const byDay = new Map();
  for (const item of state.planner) {
    if (!item.scheduledAt) continue;
    const key = localDateKey(item.scheduledAt);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  }
  for (const items of byDay.values()) items.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const todayKey = localDateKey(new Date());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDateKey(date);
    const outside = date.getMonth() !== month;
    const items = byDay.get(key) || [];
    const visible = items.slice(0, 3);
    const events = visible.map((item) => {
      const meta = plannerStatusMeta(item.status);
      const title = item.payload?.title || item.payload?.caption?.slice(0, 36) || 'Publicação';
      const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.scheduledAt));
      return `<button type="button" class="calendar-event ${meta.className}" data-planner-edit="${escapeHtml(item.id)}"><span>${time}</span><b>${escapeHtml(title)}</b></button>`;
    }).join('');
    cells.push(`<div class="calendar-day ${outside ? 'outside' : ''} ${key === todayKey ? 'today' : ''}"><div class="calendar-day-number"><span>${date.getDate()}</span>${key === todayKey ? '<small>Hoje</small>' : ''}</div><div class="calendar-day-events">${events}${items.length > 3 ? `<button class="calendar-more" type="button" data-calendar-day="${key}">+${items.length - 3} mais</button>` : ''}</div></div>`);
  }
  grid.innerHTML = cells.join('');

  const scheduled = state.planner.filter((item) => item.status === 'scheduled').length;
  const now = Date.now();
  const weekEnd = now + 7 * 24 * 60 * 60 * 1000;
  const week = state.planner.filter((item) => item.status === 'scheduled' && item.scheduledAt && new Date(item.scheduledAt).getTime() >= now && new Date(item.scheduledAt).getTime() <= weekEnd).length;
  const attention = state.planner.filter((item) => ['failed', 'partial', 'needs_review'].includes(item.status)).length;
  $('calendarScheduledMetric').textContent = String(scheduled);
  $('calendarWeekMetric').textContent = String(week);
  $('calendarAttentionMetric').textContent = String(attention);
  renderCalendarAgenda();
  bindPlannerDynamicActions(grid);
}

function renderCalendarAgenda(dayKey = null) {
  const node = $('calendarUpcoming');
  if (!node) return;
  const items = state.planner
    .filter((item) => item.scheduledAt && ['scheduled', 'processing', 'failed', 'partial', 'needs_review'].includes(item.status) && (!dayKey || localDateKey(item.scheduledAt) === dayKey))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 20);
  $('calendarAgendaCount').textContent = String(items.length);
  if (!items.length) {
    node.innerHTML = '<div class="empty-state compact"><span>□</span><strong>Agenda vazia</strong><p>Seus próximos conteúdos aparecerão aqui.</p></div>';
    return;
  }
  node.innerHTML = items.map((item) => {
    const meta = plannerStatusMeta(item.status);
    const title = item.payload?.title || item.payload?.caption?.slice(0, 80) || 'Publicação';
    const logos = (item.payload?.platforms || []).slice(0, 5).map((platform) => `<span class="mini-network ${networks[platform]?.logoClass || ''}">${networks[platform]?.logo || '?'}</span>`).join('');
    const actions = item.status === 'scheduled'
      ? `<button type="button" data-planner-edit="${escapeHtml(item.id)}">Editar</button><button type="button" data-planner-publish-now="${escapeHtml(item.id)}">Publicar agora</button><button type="button" data-planner-unschedule="${escapeHtml(item.id)}">Cancelar agenda</button>`
      : `<button type="button" data-planner-edit="${escapeHtml(item.id)}">Abrir</button>`;
    return `<article class="agenda-item ${meta.className}"><div class="agenda-time"><strong>${new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(item.scheduledAt))}</strong><span>${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.scheduledAt))}</span></div><div class="agenda-copy"><div><strong>${escapeHtml(title)}</strong><span class="status-tag ${meta.className}"><i></i>${meta.label}</span></div><div class="dashboard-recent-networks">${logos}</div>${item.lastError ? `<small class="agenda-error">${escapeHtml(item.lastError)}</small>` : ''}<div class="agenda-actions">${actions}</div></div></article>`;
  }).join('');
  bindPlannerDynamicActions(node);
}

function renderDrafts() {
  const node = $('draftList');
  if (!node) return;
  if (state.loadErrors.planner) {
    node.innerHTML = loadErrorHtml('planner', 'Não foi possível carregar os rascunhos', state.loadErrors.planner);
    if ($('draftMetric')) $('draftMetric').textContent = '--';
    if ($('draftMediaMetric')) $('draftMediaMetric').textContent = '--';
    if ($('draftAttentionMetric')) $('draftAttentionMetric').textContent = '--';
    return;
  }
  const candidates = state.planner.filter((item) => ['draft', 'failed', 'partial', 'needs_review'].includes(item.status));
  const query = state.draftFilters.query.trim().toLowerCase();
  const items = candidates.filter((item) => {
    if (state.draftFilters.status !== 'all' && item.status !== state.draftFilters.status) return false;
    const haystack = `${item.payload?.title || ''} ${item.payload?.caption || ''}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  $('draftMetric').textContent = String(candidates.filter((item) => item.status === 'draft').length);
  $('draftMediaMetric').textContent = String(candidates.filter((item) => item.media?.available).length);
  $('draftAttentionMetric').textContent = String(candidates.filter((item) => item.status !== 'draft').length);
  if (!candidates.length) {
    node.innerHTML = '<div class="empty-state publications-empty"><span>✎</span><strong>Nenhum rascunho</strong><p>Salve uma publicação para continuar trabalhando nela depois.</p><button type="button" data-go-page="publish">Criar conteúdo</button></div>';
    return;
  }
  if (!items.length) {
    node.innerHTML = '<div class="empty-state compact"><span>⌕</span><strong>Nenhum resultado</strong><p>Tente outra busca ou filtro.</p></div>';
    return;
  }
  node.innerHTML = items.map((item) => {
    const meta = plannerStatusMeta(item.status);
    const title = item.payload?.title || item.payload?.caption?.slice(0, 100) || 'Rascunho sem título';
    const kind = item.payload?.mediaKind || 'text';
    const kindIcon = kind === 'video' ? '▶' : kind === 'image' ? '▧' : '≡';
    const platforms = item.payload?.platforms || [];
    const logos = platforms.map((platform) => `<span class="mini-network ${networks[platform]?.logoClass || ''}" title="${escapeHtml(networks[platform]?.label || platform)}">${networks[platform]?.logo || '?'}</span>`).join('');
    return `<article class="draft-card ${meta.className}"><div class="draft-kind">${kindIcon}</div><div class="draft-copy"><div class="draft-title-line"><strong>${escapeHtml(title)}</strong><span class="status-tag ${meta.className}"><i></i>${meta.label}</span></div><p>${escapeHtml(item.payload?.caption || 'Sem legenda')}</p><div class="draft-meta"><span>Atualizado ${formatDate(item.updatedAt)}</span>${item.media ? `<span>${item.media.available ? 'Mídia preservada' : 'Mídia indisponível'}</span>` : ''}<div class="dashboard-recent-networks">${logos}</div></div>${item.lastError ? `<div class="draft-warning">${escapeHtml(item.lastError)}</div>` : ''}</div><div class="draft-actions"><button class="secondary-action" type="button" data-planner-edit="${escapeHtml(item.id)}">${item.status === 'draft' ? 'Continuar editando' : 'Abrir e revisar'}</button><button class="danger-text-btn" type="button" data-planner-delete="${escapeHtml(item.id)}">Excluir</button></div></article>`;
  }).join('');
  bindPlannerDynamicActions(node);
}

function renderPlannerSurfaces() {
  renderPlannerNavigationCounts();
  renderCalendar();
  renderDrafts();
  renderDashboardUpcoming();
  renderMetrics();
}

function publicationStatus(entry) {
  const results = Object.values(entry.results || {});
  const success = results.filter((item) => item.status === 'success').length;
  const errors = results.filter((item) => item.status === 'error').length;
  if (entry.demoMode && !errors) return { key: 'demo', label: 'Simulada', className: 'warning' };
  if (errors && success) return { key: 'partial', label: 'Parcial', className: 'danger' };
  if (errors) return { key: 'error', label: 'Falhou', className: 'danger' };
  if (success) return { key: 'success', label: 'Concluída', className: 'success' };
  return { key: 'pending', label: 'Sem resultado', className: 'neutral' };
}

function friendlyResultMessage(platform, result = {}) {
  const raw = String(result.message || '').trim();
  if (result.status === 'success') return result.url ? 'Publicado com sucesso. O conteúdo já está disponível na rede.' : 'Envio concluído com sucesso.';
  if (result.status === 'skipped') return 'Esta rede foi ignorada neste envio.';
  const value = raw.toLowerCase();
  if (/token|expired|expir|oauth|unauthor|401/.test(value)) return 'A conexão com esta conta precisa ser renovada.';
  if (/permission|permiss|scope|forbidden|403/.test(value)) return 'A conta conectada não tem a permissão necessária para concluir esta publicação.';
  if (/public.*url|url publica|url pública|verified|verificad|domain|domínio|dominio/.test(value)) return 'A rede não conseguiu acessar a mídia. A configuração de mídia pública precisa de atenção.';
  if (/duration|duraç|duracao|seconds|segundos/.test(value)) return 'O vídeo não atende ao limite de duração aceito por esta rede.';
  if (/mime|format|formato|jpeg|png|mp4|mov|webm/.test(value)) return 'O formato do arquivo não é aceito por esta rede.';
  if (/size|tamanho|bytes|too large|grande demais/.test(value)) return 'O arquivo ultrapassa o tamanho aceito por esta rede.';
  if (/quota|rate limit|429|too many/.test(value)) return 'A rede limitou temporariamente novos envios. Tente novamente mais tarde.';
  if (/timeout|timed out|tempo limite/.test(value)) return 'A rede demorou demais para responder. Vale tentar novamente.';
  if (platform === 'tiktok' && /audit|review|private|privacy|privad/.test(value)) return 'O TikTok restringiu esta publicação conforme o status ou as permissões atuais do aplicativo.';
  return 'A rede não concluiu este envio. Os detalhes técnicos estão disponíveis abaixo.';
}

function filteredHistory() {
  const filters = state.historyFilters;
  const query = filters.query.trim().toLowerCase();
  return state.history.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
    const status = publicationStatus(entry).key;
    const platforms = Object.keys(entry.results || {});
    const haystack = `${entry.title || ''} ${entry.caption || ''}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (filters.platform !== 'all' && !platforms.includes(filters.platform)) return false;
    if (filters.status !== 'all' && status !== filters.status) return false;
    if (filters.kind !== 'all' && entry.mediaKind !== filters.kind) return false;
    return true;
  });
}

function renderHistoryMetrics() {
  const statuses = state.history.map(publicationStatus);
  const completed = statuses.filter((status) => ['success', 'demo'].includes(status.key)).length;
  const attention = statuses.filter((status) => ['partial', 'error'].includes(status.key)).length;
  if ($('historyTotalMetric')) $('historyTotalMetric').textContent = String(state.history.length);
  if ($('historySuccessMetric')) $('historySuccessMetric').textContent = String(completed);
  if ($('historyAttentionMetric')) $('historyAttentionMetric').textContent = String(attention);
}

function updateHistoryFilterUi() {
  const filters = state.historyFilters;
  const active = Boolean(filters.query || filters.platform !== 'all' || filters.status !== 'all' || filters.kind !== 'all');
  $('clearHistoryFilters')?.classList.toggle('hidden', !active);
}

function reusePublication(index) {
  const entry = state.history[index];
  if (!entry) return;
  const kind = ['text', 'image', 'video'].includes(entry.mediaKind) ? entry.mediaKind : 'text';
  clearMedia({ markDirty: false });
  state.plannerEditId = null;
  state.plannerExistingMedia = null;
  state.plannerRemoveMedia = false;
  state.networkContent = structuredClone(entry.networkContent || {});
  $('plannerEditBanner')?.classList.add('hidden');
  setKind(kind, { keepFile: true });
  $('title').value = entry.title || '';
  $('caption').value = entry.caption || '';
  updateNetworkAvailability();
  const destinations = Object.keys(entry.results || {});
  $$('input[name="platform"]').forEach((input) => {
    input.checked = destinations.includes(input.value) && !input.disabled;
  });
  state.previewPlatform = null;
  state.maxPublishStep = 1;
  setPublishStep(1, { force: true });
  markPlannerDirty();
  refreshUi();
  navigateToPage('publish');
  toast(kind === 'text' ? 'Conteúdo reaproveitado. Revise antes de publicar.' : 'Conteúdo reaproveitado. Selecione novamente o arquivo de mídia.', 'success');
}

function renderHistory() {
  const node = $('history');
  if (!node) return;
  if (state.loadErrors.history) {
    if ($('historyTotalMetric')) $('historyTotalMetric').textContent = '--';
    if ($('historySuccessMetric')) $('historySuccessMetric').textContent = '--';
    if ($('historyAttentionMetric')) $('historyAttentionMetric').textContent = '--';
    if ($('historyResultCount')) $('historyResultCount').textContent = 'indisponível';
    node.innerHTML = loadErrorHtml('history', 'Não foi possível carregar as publicações', state.loadErrors.history);
    return;
  }
  renderHistoryMetrics();
  updateHistoryFilterUi();
  const items = filteredHistory();
  if ($('historyResultCount')) $('historyResultCount').textContent = `${items.length} ${items.length === 1 ? 'publicação' : 'publicações'}`;

  if (!state.history.length) {
    node.innerHTML = '<div class="empty-state publications-empty"><span>▤</span><strong>Nenhuma publicação ainda</strong><p>Quando você fizer o primeiro envio, o resultado aparecerá aqui.</p><button type="button" data-go-page="publish">Criar primeira publicação</button></div>';
    renderMetrics();
    return;
  }
  if (!items.length) {
    node.innerHTML = '<div class="empty-state publications-empty"><span>⌕</span><strong>Nenhum resultado encontrado</strong><p>Tente remover algum filtro ou buscar por outro termo.</p><button type="button" data-clear-history-filters>Limpar filtros</button></div>';
    node.querySelector('[data-clear-history-filters]')?.addEventListener('click', clearHistoryFilters);
    renderMetrics();
    return;
  }

  node.innerHTML = items.map(({ entry, index }) => {
    const resultEntries = Object.entries(entry.results || {});
    const status = publicationStatus(entry);
    const successCount = resultEntries.filter(([, result]) => result.status === 'success').length;
    const errorCount = resultEntries.filter(([, result]) => result.status === 'error').length;
    const title = entry.title || entry.caption?.slice(0, 90) || 'Publicação sem título';
    const kindLabel = entry.mediaKind === 'video' ? 'Vídeo' : entry.mediaKind === 'image' ? 'Imagem' : 'Texto';
    const kindIcon = entry.mediaKind === 'video' ? '▶' : entry.mediaKind === 'image' ? '▧' : '≡';
    const logos = resultEntries.map(([platform, result]) => `<span class="history-network-icon ${networks[platform]?.logoClass || ''} ${result.status}" title="${escapeHtml(networks[platform]?.label || platform)}">${networks[platform]?.logo || '?'}</span>`).join('');
    const destinationSummary = resultEntries.length ? `${successCount} de ${resultEntries.length} concluída${resultEntries.length === 1 ? '' : 's'}${errorCount ? ` · ${errorCount} com problema` : ''}` : 'Nenhum destino registrado';
    const details = resultEntries.map(([platform, result]) => {
      const meta = networks[platform] || { label: platform, logo: '?', logoClass: '' };
      const friendly = friendlyResultMessage(platform, result);
      const raw = resultTechnicalText(result).trim();
      return `<article class="publication-result-card ${result.status}">
        <span class="connection-logo ${meta.logoClass}">${meta.logo}</span>
        <div class="publication-result-copy"><div><strong>${meta.label}</strong><span class="result-status ${result.status}">${result.status === 'success' ? 'Publicado' : result.status === 'error' ? 'Falhou' : 'Ignorado'}</span></div><p>${escapeHtml(friendly)}</p>${raw ? `<details class="technical-result"><summary>Detalhes técnicos</summary><code>${escapeHtml(raw)}</code></details>` : ''}</div>
        ${result.url ? `<a class="publication-open-link" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">Abrir ↗</a>` : ''}
      </article>`;
    }).join('');

    const variants = Object.entries(entry.networkContent || {}).filter(([platform, value]) => networks[platform] && value?.customized);
    const variantsHtml = variants.length ? `<details class="history-variants"><summary>Ver ${variants.length} versão${variants.length === 1 ? '' : 'ões'} específica${variants.length === 1 ? '' : 's'} por rede</summary><div>${variants.map(([platform, value]) => `<article><span class="mini-network ${networks[platform].logoClass}">${networks[platform].logo}</span><div><strong>${escapeHtml(networks[platform].label)}</strong>${value.title ? `<b>${escapeHtml(value.title)}</b>` : ''}<p>${escapeHtml(value.caption || 'Sem texto específico')}</p></div></article>`).join('')}</div></details>` : '';
    return `<details class="history-entry publication-entry">
      <summary>
        <div class="history-main"><span class="history-kind">${kindIcon}</span><span><strong>${escapeHtml(title)}</strong><small>${formatDate(entry.createdAt)} · ${kindLabel}${variants.length ? ` · ${variants.length} variação${variants.length === 1 ? '' : 'ões'}` : ''}</small></span></div>
        <div class="history-destination-summary"><div class="history-network-stack">${logos}</div><small>${destinationSummary}</small></div>
        <span class="status-tag ${status.className}"><i></i>${status.label}</span>
        <span class="details-arrow">⌄</span>
      </summary>
      <div class="history-details publication-details">
        <div class="publication-caption"><span>Conteúdo principal</span><p>${escapeHtml(entry.caption || 'Sem legenda')}</p></div>
        ${variantsHtml}
        <div class="publication-detail-actions"><button type="button" data-reuse-history="${index}">↻ Usar conteúdo novamente</button><span>${entry.durationMs ? `Envio processado em ${(entry.durationMs / 1000).toFixed(1)}s` : 'Tempo de processamento não registrado'}</span></div>
        <div class="result-details">${details || '<div class="empty-state compact">Nenhum resultado por rede registrado.</div>'}</div>
      </div>
    </details>`;
  }).join('');

  $$('[data-reuse-history]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    reusePublication(Number(button.dataset.reuseHistory));
  }));
  renderMetrics();
}

function clearHistoryFilters() {
  state.historyFilters = { query: '', platform: 'all', status: 'all', kind: 'all' };
  if ($('historySearch')) $('historySearch').value = '';
  if ($('historyPlatformFilter')) $('historyPlatformFilter').value = 'all';
  if ($('historyStatusFilter')) $('historyStatusFilter').value = 'all';
  if ($('historyKindFilter')) $('historyKindFilter').value = 'all';
  renderHistory();
}

function updateSettingsModeBadge() {
  const badge = $('settingsModeBadge');
  if (!badge) return;
  const demo = $('settingsDemoMode')?.checked ?? true;
  badge.textContent = demo ? 'Demo' : 'Real';
  badge.className = `status-tag ${demo ? 'warning' : 'success'}`;
}

function updateCallbackPreviews() {
  const base = String($('settingsAppBaseUrl')?.value || '').trim().replace(/\/+$/, '');
  if (!base) return;
  $('youtubeCallback').textContent = `${base}/auth/youtube/callback`;
  $('instagramCallback').textContent = `${base}/auth/instagram/callback`;
  $('linkedinCallback').textContent = `${base}/auth/linkedin/callback`;
  $('tiktokCallback').textContent = `${base}/auth/tiktok/callback`;
  $('facebookCallback').textContent = `${base}/auth/facebook/callback`;
  $('googleBusinessCallback').textContent = `${base}/auth/google-business/callback`;
}

function setCredentialBadge(id, configured) {
  const badge = $(id);
  badge.textContent = configured ? 'Credencial salva' : 'Não configurado';
  badge.className = `status-tag ${configured ? 'success' : 'neutral'}`;
}

function populateFacebookPages(selectedValue = '') {
  const select = $('settingsFacebookPageId');
  if (!select) return;
  const pages = state.config?.connections?.facebook?.pages || [];
  select.innerHTML = '<option value="">Automático — primeira página com permissão</option>'
    + pages.map((page) => `<option value="${escapeHtml(page.id)}">${escapeHtml(page.name)} (${escapeHtml(page.id)})</option>`).join('');
  select.value = selectedValue && pages.some((page) => page.id === selectedValue) ? selectedValue : '';
}

function populateGoogleBusinessLocations(selectedValue = '') {
  const select = $('settingsGoogleBusinessLocation');
  if (!select) return;
  const locations = state.config?.connections?.googleBusiness?.locations || [];
  select.innerHTML = '<option value="">Automático — primeira unidade disponível</option>'
    + locations.map((loc) => `<option value="${escapeHtml(loc.name)}">${escapeHtml(loc.title || loc.name)}</option>`).join('');
  select.value = selectedValue && locations.some((loc) => loc.name === selectedValue) ? selectedValue : '';
}

function updateGoogleBusinessCredentialFields() {
  const useYoutube = $('settingsGoogleBusinessUseYoutube')?.checked ?? true;
  ['settingsGoogleBusinessClientId', 'settingsGoogleBusinessClientSecret'].forEach((id) => {
    if ($(id)) $(id).disabled = useYoutube;
  });
}

async function loadTikTokCreatorInfo() {
  state.tiktokCreator = null;
  const select = $('tiktokPrivacy');
  if (!select) return;
  const connected = Boolean(state.config?.connections?.tiktok?.connected);
  if (!connected || state.config?.demoMode) {
    select.innerHTML = '<option value="">Selecione a privacidade</option><option value="SELF_ONLY">Somente eu</option><option value="PUBLIC_TO_EVERYONE">Público</option><option value="MUTUAL_FOLLOW_FRIENDS">Amigos mútuos</option><option value="FOLLOWER_OF_CREATOR">Seguidores</option>';
    select.value = '';
    $('tiktokCreatorLabel').textContent = state.config?.demoMode ? 'Modo Demo: opções simuladas.' : 'Conecte o TikTok para consultar as opções reais.';
    return;
  }
  try {
    const response = await apiFetch('api/tiktok/creator-info', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Falha ao consultar TikTok');
    state.tiktokCreator = data;
    $('tiktokCreatorLabel').textContent = data.creator_nickname
      ? `Conta: ${data.creator_nickname}${data.max_video_post_duration_sec ? ` · limite de vídeo ${data.max_video_post_duration_sec}s` : ''}`
      : 'Opções consultadas diretamente do TikTok.';
    const options = Array.isArray(data.privacy_level_options) && data.privacy_level_options.length ? data.privacy_level_options : ['SELF_ONLY'];
    const labels = { PUBLIC_TO_EVERYONE: 'Público', MUTUAL_FOLLOW_FRIENDS: 'Amigos mútuos', FOLLOWER_OF_CREATOR: 'Seguidores', SELF_ONLY: 'Somente eu' };
    select.innerHTML = '<option value="">Selecione a privacidade</option>' + options.map((value) => `<option value="${value}">${labels[value] || value}</option>`).join('');
    select.value = '';
    const commentDisabled = Boolean(data.comment_disabled);
    const duetDisabled = Boolean(data.duet_disabled);
    const stitchDisabled = Boolean(data.stitch_disabled);
    $('tiktokAllowComment').disabled = commentDisabled; $('tiktokAllowComment').checked = false;
    $('tiktokAllowDuet').disabled = duetDisabled; $('tiktokAllowDuet').checked = false;
    $('tiktokAllowStitch').disabled = stitchDisabled; $('tiktokAllowStitch').checked = false;
    $('tiktokCommentHelp').textContent = commentDisabled ? 'Desativado nas configurações da conta.' : 'Ative se quiser permitir comentários.';
    $('tiktokDuetHelp').textContent = duetDisabled ? 'Indisponível para esta conta.' : 'Ative se quiser permitir Duet.';
    $('tiktokStitchHelp').textContent = stitchDisabled ? 'Indisponível para esta conta.' : 'Ative se quiser permitir Stitch.';
  } catch (error) {
    select.innerHTML = '<option value="">Indisponível — reconecte o TikTok</option>';
    select.value = '';
    $('tiktokCreatorLabel').textContent = 'Não foi possível consultar as opções; tente reconectar o TikTok.';
    console.warn(error);
  }
  refreshUi();
}

function renderSettings(settings) {
  state.settings = settings;
  $('settingsDemoMode').checked = Boolean(settings.general?.demoMode);
  $('settingsAppBaseUrl').value = settings.general?.appBaseUrl || 'http://localhost:3000';
  $('settingsPublicBaseUrl').value = settings.general?.publicBaseUrl || settings.general?.appBaseUrl || 'http://localhost:3000';
  if ($('settingsMaxUploadMb')) $('settingsMaxUploadMb').value = settings.general?.maxUploadMb || 4096;

  $('settingsYoutubeClientId').value = settings.youtube?.clientId || '';
  $('settingsYoutubeClientSecret').value = '';
  $('settingsYoutubeChunkMb').value = settings.youtube?.chunkMb || 8;
  $('youtubeCallback').textContent = settings.youtube?.redirectUri || '--';
  setCredentialBadge('youtubeSecretState', Boolean(settings.youtube?.clientId && settings.youtube?.hasClientSecret));
  $('youtubeSecretHelp').textContent = settings.youtube?.hasClientSecret
    ? 'Segredo já salvo no backend. Deixe em branco para manter.'
    : 'Nenhum segredo salvo. Cole o Client Secret para habilitar a conexão.';

  $('settingsInstagramAppId').value = settings.instagram?.appId || '';
  $('settingsInstagramAppSecret').value = '';
  $('settingsMetaVersion').value = settings.instagram?.graphVersion || 'v26.0';
  $('instagramCallback').textContent = settings.instagram?.redirectUri || '--';
  setCredentialBadge('instagramSecretState', Boolean(settings.instagram?.appId && settings.instagram?.hasAppSecret));
  $('instagramSecretHelp').textContent = settings.instagram?.hasAppSecret
    ? 'Segredo já salvo no backend. Deixe em branco para manter.'
    : 'Nenhum segredo salvo. Cole o App Secret para habilitar a conexão.';

  $('settingsLinkedinClientId').value = settings.linkedin?.clientId || '';
  $('settingsLinkedinClientSecret').value = '';
  $('settingsLinkedinScopes').value = settings.linkedin?.scopes || 'openid profile w_member_social';
  $('settingsLinkedinVersion').value = settings.linkedin?.version || '202609';
  $('settingsLinkedinAuthorUrn').value = settings.linkedin?.authorUrn || '';
  $('linkedinCallback').textContent = settings.linkedin?.redirectUri || '--';
  setCredentialBadge('linkedinSecretState', Boolean(settings.linkedin?.clientId && settings.linkedin?.hasClientSecret));
  $('linkedinSecretHelp').textContent = settings.linkedin?.hasClientSecret
    ? 'Segredo já salvo no backend. Deixe em branco para manter.'
    : 'Nenhum segredo salvo. Cole o Client Secret para habilitar a conexão.';

  $('settingsTiktokClientKey').value = settings.tiktok?.clientKey || '';
  $('settingsTiktokClientSecret').value = '';
  $('settingsTiktokScopes').value = settings.tiktok?.scopes || 'user.info.basic,video.publish';
  $('settingsTiktokVerifiedMediaBaseUrl').value = settings.tiktok?.verifiedMediaBaseUrl || '';
  $('tiktokCallback').textContent = settings.tiktok?.redirectUri || '--';
  setCredentialBadge('tiktokSecretState', Boolean(settings.tiktok?.clientKey && settings.tiktok?.hasClientSecret));
  $('tiktokSecretHelp').textContent = settings.tiktok?.hasClientSecret
    ? 'Segredo já salvo no backend. Deixe em branco para manter.'
    : 'Nenhum segredo salvo. Cole o Client Secret para habilitar a conexão.';

  $('settingsFacebookAppId').value = settings.facebook?.appId || '';
  $('settingsFacebookAppSecret').value = '';
  $('settingsFacebookVersion').value = settings.facebook?.graphVersion || 'v26.0';
  $('settingsFacebookScopes').value = settings.facebook?.scopes || 'pages_show_list,pages_read_engagement,pages_manage_posts';
  $('facebookCallback').textContent = settings.facebook?.redirectUri || '--';
  setCredentialBadge('facebookSecretState', Boolean(settings.facebook?.appId && settings.facebook?.hasAppSecret));
  $('facebookSecretHelp').textContent = settings.facebook?.hasAppSecret
    ? 'Segredo já salvo no backend. Deixe em branco para manter.'
    : 'Nenhum segredo salvo. Cole o App Secret para habilitar a conexão.';
  populateFacebookPages(settings.facebook?.pageId || '');

  $('settingsGoogleBusinessUseYoutube').checked = settings.googleBusiness?.useYoutubeCredentials !== false;
  $('settingsGoogleBusinessClientId').value = settings.googleBusiness?.clientId || '';
  $('settingsGoogleBusinessClientSecret').value = '';
  $('googleBusinessCallback').textContent = settings.googleBusiness?.redirectUri || '--';
  setCredentialBadge('googleBusinessSecretState', Boolean(settings.googleBusiness?.hasClientSecret));
  $('googleBusinessSecretHelp').textContent = settings.googleBusiness?.useYoutubeCredentials
    ? 'Usando as credenciais Google do YouTube. A autorização do Perfil da Empresa é separada.'
    : settings.googleBusiness?.hasClientSecret
      ? 'Segredo próprio já salvo no backend. Deixe em branco para manter.'
      : 'Informe Client ID/Secret próprios ou ative o uso das credenciais do YouTube.';
  updateGoogleBusinessCredentialFields();
  populateGoogleBusinessLocations(settings.googleBusiness?.locationName || '');

  updateSettingsModeBadge();
  renderAdminIntegrationState();
  updateAdminPublicLinks();
}

function setSettingsButtonsDisabled(disabled) {
  $$('[data-save-settings]').forEach((button) => { button.disabled = Boolean(disabled); });
  $$('[data-clear-credentials]').forEach((button) => { button.disabled = Boolean(disabled); });
}

function renderAdminIntegrationState() {
  const summary = $('adminIntegrationSummary');
  if (!state.config) return;
  const entries = Object.entries(networks);
  const configured = entries.filter(([platform]) => state.config.connections?.[platform]?.configured).length;
  const connected = entries.filter(([platform]) => { const item = state.config.connections?.[platform] || {}; return item.connected && !item.expired && !item.needsReconnect; }).length;
  const attention = entries.filter(([platform]) => {
    const item = state.config.connections?.[platform] || {};
    return item.expired || item.needsReconnect || !item.configured;
  }).length;

  if (summary) {
    summary.innerHTML = `<div class="admin-summary-card"><span class="admin-summary-icon ready">✓</span><div><strong>${configured} de ${entries.length}</strong><small>integrações configuradas</small></div></div><div class="admin-summary-card"><span class="admin-summary-icon connected">◎</span><div><strong>${connected}</strong><small>contas conectadas</small></div></div><div class="admin-summary-card"><span class="admin-summary-icon ${attention ? 'attention' : 'ready'}">${attention ? '!' : '✓'}</span><div><strong>${attention}</strong><small>itens que pedem atenção</small></div></div>`;
  }

  entries.forEach(([platform]) => {
    const item = state.config.connections?.[platform] || {};
    const node = $(`${platform}AdminConnectionText`);
    if (!node) return;
    if (item.expired || item.needsReconnect) node.textContent = 'Conta precisa ser reconectada';
    else if (item.connected) node.textContent = item.name ? `Conectado como ${item.name}` : 'Conta conectada';
    else if (item.configured) node.textContent = 'Credenciais prontas · falta conectar a conta';
    else node.textContent = 'Credenciais ainda não configuradas';
  });
}

function updateAdminPublicLinks() {
  const raw = String(state.settings?.general?.appBaseUrl || state.config?.appBaseUrl || '').replace(/\/$/, '');
  if ($('adminAboutUrl')) $('adminAboutUrl').textContent = raw ? `${raw}/about` : '--';
  if ($('adminPublicAppUrl')) $('adminPublicAppUrl').textContent = raw || '--';
  if ($('adminTermsUrl')) $('adminTermsUrl').textContent = raw ? `${raw}/terms` : '--';
  if ($('adminPrivacyUrl')) $('adminPrivacyUrl').textContent = raw ? `${raw}/privacy` : '--';
}

async function loadSettings() {
  const response = await apiFetch('api/settings', { cache: 'no-store' });
  if (response.status === 403) {
    state.settingsWritable = false;
    const data = await response.json().catch(() => ({}));
    const alert = $('settingsAccessAlert');
    if (alert) {
      alert.textContent = data.error || 'Sua conta não possui acesso à Administração.';
      alert.className = 'alert warning';
    }
    setSettingsButtonsDisabled(true);
    return;
  }
  if (!response.ok) throw new Error('Falha ao carregar as configurações das APIs');
  state.settingsWritable = true;
  if ($('settingsAccessAlert')) $('settingsAccessAlert').className = 'alert hidden';
  setSettingsButtonsDisabled(false);
  renderSettings(await response.json());
  renderAdminIntegrationState();
  updateAdminPublicLinks();
}

function settingsPayloadForSection(section) {
  const payloads = {
    general: () => ({ general: {
      demoMode: $('settingsDemoMode').checked,
      appBaseUrl: $('settingsAppBaseUrl').value.trim(),
      publicBaseUrl: $('settingsPublicBaseUrl').value.trim(),
      maxUploadMb: Number($('settingsMaxUploadMb').value || 4096),
    } }),
    youtube: () => ({ youtube: {
      clientId: $('settingsYoutubeClientId').value.trim(),
      clientSecret: $('settingsYoutubeClientSecret').value,
      redirectUri: '',
      chunkMb: Number($('settingsYoutubeChunkMb').value || 8),
    } }),
    instagram: () => ({ instagram: {
      appId: $('settingsInstagramAppId').value.trim(),
      appSecret: $('settingsInstagramAppSecret').value,
      redirectUri: '',
      graphVersion: $('settingsMetaVersion').value.trim(),
    } }),
    linkedin: () => ({ linkedin: {
      clientId: $('settingsLinkedinClientId').value.trim(),
      clientSecret: $('settingsLinkedinClientSecret').value,
      redirectUri: '',
      scopes: $('settingsLinkedinScopes').value.trim(),
      version: $('settingsLinkedinVersion').value.trim(),
      authorUrn: $('settingsLinkedinAuthorUrn').value.trim(),
    } }),
    tiktok: () => ({ tiktok: {
      clientKey: $('settingsTiktokClientKey').value.trim(),
      clientSecret: $('settingsTiktokClientSecret').value,
      redirectUri: '',
      scopes: $('settingsTiktokScopes').value.trim(),
      verifiedMediaBaseUrl: $('settingsTiktokVerifiedMediaBaseUrl').value.trim(),
    } }),
    facebook: () => ({ facebook: {
      appId: $('settingsFacebookAppId').value.trim(),
      appSecret: $('settingsFacebookAppSecret').value,
      redirectUri: '',
      graphVersion: $('settingsFacebookVersion').value.trim(),
      scopes: $('settingsFacebookScopes').value.trim(),
      pageId: $('settingsFacebookPageId').value,
    } }),
    googleBusiness: () => ({ googleBusiness: {
      useYoutubeCredentials: $('settingsGoogleBusinessUseYoutube').checked,
      clientId: $('settingsGoogleBusinessClientId').value.trim(),
      clientSecret: $('settingsGoogleBusinessClientSecret').value,
      redirectUri: '',
      locationName: $('settingsGoogleBusinessLocation').value,
      accountName: '',
    } }),
  };
  return payloads[section]?.() || null;
}

async function saveSettingsSection(section, button) {
  if (!state.settingsWritable) return;
  const payload = settingsPayloadForSection(section);
  if (!payload) return;
  const original = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.innerHTML = section === 'general' ? '<span>◌</span>Salvando...' : '◌ Salvando...';
  }
  try {
    const response = await apiFetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível salvar esta configuração');
    renderSettings(data.settings);
    const refresh = await Promise.allSettled([loadConfig(), loadDiagnostics({ silent: true })]);
    const label = section === 'general' ? 'Sistema' : networks[section]?.label || 'Integração';
    toast(`${label} salvo com sucesso.`, 'success');
    if (refresh.some((item) => item.status === 'rejected')) toast('A alteração foi salva, mas parte da tela não pôde ser atualizada agora.', 'error');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = !state.settingsWritable;
      button.innerHTML = original;
    }
  }
}

function diagnosticStatusMeta(status) {
  if (status === 'ok') return { icon: '✓', label: 'OK', className: 'success' };
  if (status === 'error') return { icon: '×', label: 'Erro', className: 'error' };
  return { icon: '!', label: 'Atenção', className: 'warning' };
}

function renderDiagnostics(data) {
  state.diagnostics = data;
  const summary = $('diagnosticsSummary');
  const system = $('diagnosticsChecks');
  const platforms = $('diagnosticsPlatforms');
  const callbacks = $('diagnosticsCallbacks');
  if (!summary || !system || !platforms || !callbacks) return;

  const overall = diagnosticStatusMeta(data.status || 'warning');
  summary.innerHTML = `<div class="diagnostics-hero ${overall.className}"><span>${overall.icon}</span><div><p class="eyebrow">STATUS GERAL</p><strong>${data.status === 'ok' ? 'Estrutura pronta para operar' : data.status === 'error' ? 'Há um problema que impede o funcionamento completo' : 'Sistema funcionando com pontos de atenção'}</strong><small>Verificado em ${formatDate(data.generatedAt)}</small></div></div><div class="diagnostics-kpis"><div><b>${data.summary?.platformsConfigured ?? 0}/6</b><span>APIs configuradas</span></div><div><b>${data.summary?.platformsConnected ?? 0}/6</b><span>contas conectadas</span></div><div><b>${data.summary?.attention ?? 0}</b><span>pontos de atenção</span></div></div>`;

  system.innerHTML = (data.system || []).map((item) => {
    const meta = diagnosticStatusMeta(item.status);
    return `<div class="diagnostic-row"><span class="diagnostic-state ${meta.className}">${meta.icon}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail || '')}</small></div><span class="diagnostic-label ${meta.className}">${meta.label}</span></div>`;
  }).join('') || '<div class="empty-state compact">Sem dados de sistema.</div>';

  platforms.innerHTML = (data.platforms || []).map((item) => {
    const meta = diagnosticStatusMeta(item.status);
    const network = networks[item.key] || { label: item.label, logo: '•', logoClass: '' };
    return `<div class="diagnostic-row"><span class="connection-logo ${network.logoClass}">${network.logo}</span><div><strong>${escapeHtml(network.label)}</strong><small>${escapeHtml(item.detail || '')}</small></div><span class="diagnostic-label ${meta.className}">${meta.label}</span></div>`;
  }).join('') || '<div class="empty-state compact">Sem dados das integrações.</div>';

  callbacks.innerHTML = (data.callbacks || []).map((item) => `<div class="diagnostic-callback-row"><div><span class="connection-logo ${networks[item.key]?.logoClass || ''}">${networks[item.key]?.logo || '•'}</span><strong>${escapeHtml(networks[item.key]?.label || item.label)}</strong></div><code>${escapeHtml(item.url || '--')}</code><button class="copy-btn" data-copy-diagnostic="${escapeHtml(item.key)}" type="button">Copiar</button></div>`).join('');
  $$('[data-copy-diagnostic]').forEach((button) => button.addEventListener('click', async () => {
    const item = (state.diagnostics?.callbacks || []).find((entry) => entry.key === button.dataset.copyDiagnostic);
    if (!item?.url) return;
    await copyRawText(item.url, 'Callback copiado.');
  }));
}

async function loadDiagnostics({ silent = false } = {}) {
  const button = $('runDiagnosticsBtn');
  const original = button?.textContent || '';
  if (button && !silent) {
    button.disabled = true;
    button.textContent = '↻ Verificando...';
  }
  try {
    const response = await apiFetch('api/diagnostics', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível executar o diagnóstico');
    renderDiagnostics(data);
    if (!silent) toast('Diagnóstico atualizado.', 'success');
    return data;
  } finally {
    if (button && !silent) {
      button.disabled = false;
      button.textContent = original || '↻ Verificar agora';
    }
  }
}

async function copyRawText(value, successMessage = 'Copiado.') {
  const text = String(value || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(successMessage, 'success');
}

async function copyDiagnostics() {
  if (!state.diagnostics) await loadDiagnostics({ silent: true });
  const d = state.diagnostics || {};
  const lines = [
    'Casa do Ads Social Publisher - Diagnóstico',
    `Gerado em: ${d.generatedAt || '--'}`,
    `Status: ${d.status || '--'}`,
    '',
    'SISTEMA',
    ...(d.system || []).map((item) => `[${String(item.status || '').toUpperCase()}] ${item.label}: ${item.detail || ''}`),
    '',
    'INTEGRAÇÕES',
    ...(d.platforms || []).map((item) => `[${String(item.status || '').toUpperCase()}] ${item.label}: ${item.detail || ''}`),
    '',
    'CALLBACKS',
    ...(d.callbacks || []).map((item) => `${item.label}: ${item.url || '--'}`),
  ];
  await copyRawText(lines.join('\n'), 'Diagnóstico copiado.');
}

async function clearCredentials(platform) {
  if (!state.settingsWritable) return;
  const label = networks[platform]?.label || platform;
  if (!window.confirm(`Limpar as credenciais de ${label}? A conta conectada também será desconectada.`)) return;

  let networkPayload;
  if (platform === 'instagram' || platform === 'facebook') {
    networkPayload = { appId: '', appSecret: '', clearAppSecret: true, redirectUri: '' };
  } else if (platform === 'tiktok') {
    networkPayload = { clientKey: '', clientSecret: '', clearClientSecret: true, redirectUri: '' };
  } else if (platform === 'googleBusiness') {
    networkPayload = { useYoutubeCredentials: false, clientId: '', clientSecret: '', clearClientSecret: true, redirectUri: '', locationName: '', accountName: '' };
  } else {
    networkPayload = { clientId: '', clientSecret: '', clearClientSecret: true, redirectUri: '' };
  }

  try {
    const response = await apiFetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [platform]: networkPayload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Não foi possível limpar ${label}`);
    const refresh = await Promise.allSettled([loadSettings(), loadConfig()]);
    const saved = data.settings?.[platform] || {};
    const stillConfigured = (platform === 'instagram' || platform === 'facebook')
      ? Boolean(saved.appId && saved.hasAppSecret)
      : platform === 'tiktok'
        ? Boolean(saved.clientKey && saved.hasClientSecret)
        : platform === 'googleBusiness'
          ? Boolean(saved.hasClientSecret && (saved.useYoutubeCredentials || saved.clientId))
          : Boolean(saved.clientId && saved.hasClientSecret);
    toast(
      stillConfigured
        ? `Configuração salva no site foi limpa, mas ${label} ainda recebe credenciais do .env.`
        : `Credenciais de ${label} removidas.`,
      stillConfigured ? '' : 'success',
    );
    if (refresh.some((item) => item.status === 'rejected')) toast('Credenciais alteradas, mas parte da tela não pôde ser atualizada agora.', 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyTextFrom(id) {
  const text = $(id)?.textContent?.trim();
  if (!text || text === '--') return;
  await copyRawText(text, 'Copiado.');
}

function publicationFormData({ mode = null, scheduledAt = null } = {}) {
  const formData = new FormData();
  formData.append('title', $('title').value.trim());
  formData.append('caption', $('caption').value.trim());
  formData.append('mediaKind', state.kind);
  formData.append('platforms', selectedPlatforms().join(','));
  formData.append('mediaUrl', $('mediaUrl').value.trim());
  formData.append('networkContent', JSON.stringify(activeNetworkContent()));
  formData.append('youtubePrivacy', $('youtubePrivacy').value);
  formData.append('tiktokPrivacy', $('tiktokPrivacy').value);
  formData.append('tiktokCommercial', String($('tiktokCommercial').checked));
  formData.append('tiktokBrandOrganic', String($('tiktokBrandOrganic').checked));
  formData.append('tiktokBrandContent', String($('tiktokBrandContent').checked));
  formData.append('tiktokAigc', String($('tiktokAigc').checked));
  formData.append('tiktokAllowComment', String($('tiktokAllowComment').checked));
  formData.append('tiktokAllowDuet', String($('tiktokAllowDuet').checked));
  formData.append('tiktokAllowStitch', String($('tiktokAllowStitch').checked));
  formData.append('tiktokConsent', String($('tiktokConsent').checked));
  if (state.file) formData.append('media', state.file, state.file.name);
  if (state.plannerRemoveMedia) formData.append('removeMedia', 'true');
  if (mode) formData.append('mode', mode);
  if (scheduledAt) formData.append('scheduledAt', scheduledAt);
  return formData;
}

function showExistingPlannerMedia(media, kind) {
  if (!media?.available || kind === 'text') return;
  state.plannerExistingMedia = media;
  state.objectUrl = media.publicUrl || null;
  $('emptyUpload').classList.add('hidden');
  $('mediaPreviewWrap').classList.remove('hidden');
  $('clearMediaBtn').classList.remove('hidden');
  $('fileName').textContent = media.originalName || 'Mídia salva';
  $('fileMeta').textContent = [formatBytes(Number(media.size || 0)), media.mimetype || 'arquivo', 'salvo no servidor'].join(' · ');
  const image = $('imagePreview');
  const video = $('videoPreview');
  image.classList.toggle('hidden', kind !== 'image');
  video.classList.toggle('hidden', kind !== 'video');
  if (kind === 'image' && media.publicUrl) image.src = media.publicUrl;
  if (kind === 'video' && media.publicUrl) video.src = media.publicUrl;
}

function resetComposer({ silent = false } = {}) {
  clearMedia({ markDirty: false });
  state.plannerEditId = null;
  state.plannerExistingMedia = null;
  state.plannerRemoveMedia = false;
  state.plannerDirty = false;
  state.networkContent = {};
  $('title').value = '';
  $('caption').value = '';
  $('mediaUrl').value = '';
  $('youtubePrivacy').value = 'private';
  if ($('tiktokPrivacy')) $('tiktokPrivacy').value = '';
  ['tiktokCommercial', 'tiktokBrandOrganic', 'tiktokBrandContent', 'tiktokAigc', 'tiktokAllowComment', 'tiktokAllowDuet', 'tiktokAllowStitch', 'tiktokConsent'].forEach((id) => { if ($(id)) $(id).checked = false; });
  $('tiktokCommercialOptions')?.classList.add('hidden');
  $$('input[name="platform"]').forEach((input) => { input.checked = false; });
  state.previewPlatform = null;
  state.maxPublishStep = 1;
  setKind('text', { keepFile: true });
  setPublishStep(1, { force: true });
  $('plannerEditBanner')?.classList.add('hidden');
  if ($('saveDraftTopBtn')) $('saveDraftTopBtn').textContent = '✎ Salvar rascunho';
  if ($('saveDraftBtn')) { $('saveDraftBtn').querySelector('b').textContent = 'Salvar rascunho'; $('saveDraftBtn').querySelector('small').textContent = 'Continuar depois'; }
  markPlannerSaved('Novo conteúdo');
  renderPublishProgress();
  setAlert();
  refreshUi();
  if (!silent) toast('Nova publicação iniciada.');
}

function beginNewPublication() {
  if (state.plannerDirty && !window.confirm('Descartar as alterações que ainda não foram salvas?')) return false;
  resetComposer({ silent: true });
  navigateToPage('publish');
  return true;
}

function ensureSelectValue(select, value) {
  if (!select || !value) return;
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = value;
}

function editPlannerItem(id) {
  const item = state.planner.find((candidate) => candidate.id === id);
  if (!item) return toast('Este item não está mais disponível.', 'error');
  if (item.status === 'published') {
    toast('Este agendamento já foi publicado. Consulte o histórico para reutilizar o conteúdo.', 'error');
    return navigateToPage('publications');
  }
  clearMedia({ markDirty: false });
  state.plannerEditId = item.id;
  state.plannerRemoveMedia = false;
  const payload = item.payload || {};
  state.networkContent = structuredClone(payload.networkContent || {});
  setKind(['text', 'image', 'video'].includes(payload.mediaKind) ? payload.mediaKind : 'text', { keepFile: true });
  $('title').value = payload.title || '';
  $('caption').value = payload.caption || '';
  $('mediaUrl').value = payload.requestedMediaUrl || '';
  $('youtubePrivacy').value = payload.youtubePrivacy || 'private';
  ensureSelectValue($('tiktokPrivacy'), payload.tiktokPrivacy || '');
  $('tiktokCommercial').checked = Boolean(payload.tiktokCommercial);
  $('tiktokBrandOrganic').checked = Boolean(payload.tiktokBrandOrganic);
  $('tiktokBrandContent').checked = Boolean(payload.tiktokBrandContent);
  $('tiktokAigc').checked = Boolean(payload.tiktokAigc);
  $('tiktokAllowComment').checked = Boolean(payload.tiktokAllowComment);
  $('tiktokAllowDuet').checked = Boolean(payload.tiktokAllowDuet);
  $('tiktokAllowStitch').checked = Boolean(payload.tiktokAllowStitch);
  $('tiktokConsent').checked = Boolean(payload.tiktokConsent);
  $('tiktokCommercialOptions').classList.toggle('hidden', !$('tiktokCommercial').checked);
  updateNetworkAvailability();
  let platforms = payload.platforms || [];
  if (item.status === 'partial' && item.results) {
    platforms = platforms.filter((platform) => item.results?.[platform]?.status !== 'success');
  }
  if (item.status === 'needs_review') platforms = [];
  $$('input[name="platform"]').forEach((input) => { input.checked = platforms.includes(input.value) && !input.disabled; });
  showExistingPlannerMedia(item.media, state.kind);
  state.previewPlatform = null;
  state.maxPublishStep = 4;
  setPublishStep(1, { force: true });
  state.plannerDirty = false;
  const status = plannerStatusMeta(item.status);
  $('plannerEditBanner')?.classList.remove('hidden');
  if ($('plannerEditTitle')) $('plannerEditTitle').textContent = item.status === 'scheduled' ? 'Editando publicação agendada' : item.status === 'draft' ? 'Editando rascunho' : 'Revisando publicação';
  if ($('plannerEditSubtitle')) $('plannerEditSubtitle').textContent = item.status === 'scheduled' && item.scheduledAt ? `Agendada para ${formatDate(item.scheduledAt)}.` : item.lastError || `${status.label}. As alterações serão salvas neste item.`;
  if ($('saveDraftTopBtn')) $('saveDraftTopBtn').textContent = item.status === 'scheduled' ? '✓ Salvar alterações' : '✎ Salvar rascunho';
  if ($('saveDraftBtn')) { $('saveDraftBtn').querySelector('b').textContent = item.status === 'scheduled' ? 'Salvar alterações' : 'Salvar rascunho'; $('saveDraftBtn').querySelector('small').textContent = item.status === 'scheduled' ? 'Manter agendamento' : 'Continuar depois'; }
  markPlannerSaved(item.status === 'scheduled' ? `Agendado · ${formatDate(item.scheduledAt)}` : 'Rascunho salvo');
  refreshUi();
  navigateToPage('publish');
  if (item.status === 'partial') toast('Para evitar duplicidade, deixei selecionadas somente as redes que falharam.', 'success');
  if (item.status === 'needs_review') toast('O envio foi interrompido e pode ter alcançado alguma rede. Selecione manualmente os destinos antes de tentar novamente.', 'error');
}

async function saveCurrentPlanner(mode = 'draft', scheduledAt = null, { navigateAfter = true, quiet = false } = {}) {
  if (mode === 'scheduled') {
    refreshUi();
    const blockers = buildPreflight().filter((check) => check.status !== 'ok');
    if (blockers.length) throw new Error(friendlyCheckDetail(blockers[0]));
  }
  const formData = publicationFormData({ mode, scheduledAt });
  const editing = Boolean(state.plannerEditId);
  const endpoint = editing ? `api/planner/${encodeURIComponent(state.plannerEditId)}` : 'api/planner';
  const response = await apiFetch(endpoint, { method: editing ? 'PUT' : 'POST', body: formData });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(data.details) ? ` ${data.details.join(' · ')}` : '';
    throw new Error(`${data.error || 'Não foi possível salvar.'}${details}`);
  }
  state.plannerEditId = data.id;
  if (data.media?.available) {
    if (state.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(state.objectUrl);
    state.file = null;
    state.objectUrl = null;
    state.plannerExistingMedia = data.media;
    showExistingPlannerMedia(data.media, state.kind);
  } else {
    state.plannerExistingMedia = null;
  }
  state.plannerRemoveMedia = false;
  state.plannerDirty = false;
  $('plannerEditBanner')?.classList.remove('hidden');
  if ($('plannerEditTitle')) $('plannerEditTitle').textContent = mode === 'scheduled' ? 'Editando publicação agendada' : 'Editando rascunho';
  if ($('plannerEditSubtitle')) $('plannerEditSubtitle').textContent = mode === 'scheduled' ? `Agendada para ${formatDate(data.scheduledAt)}.` : 'As alterações serão salvas neste rascunho.';
  markPlannerSaved(mode === 'scheduled' ? `Agendado · ${formatDate(data.scheduledAt)}` : 'Rascunho salvo');
  const plannerRefresh = await Promise.allSettled([loadPlanner()]);
  if (plannerRefresh[0]?.status === 'rejected' && !quiet) toast('Conteúdo salvo, mas a lista não pôde ser atualizada agora.', 'error');
  if (mode === 'scheduled') {
    if (!quiet) toast('Publicação agendada com sucesso.', 'success');
    if (navigateAfter) navigateToPage('calendar');
  } else {
    if (!quiet) toast('Rascunho salvo.', 'success');
  }
  return data;
}

function defaultScheduleLocalValue() {
  const date = new Date(Date.now() + 30 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function openScheduleDialog() {
  refreshUi();
  const blockers = buildPreflight().filter((check) => check.status !== 'ok');
  if (blockers.length) return toast(friendlyCheckDetail(blockers[0]), 'error');
  const input = $('scheduleDateTime');
  const min = new Date(Date.now() + 60_000);
  const offset = min.getTimezoneOffset();
  input.min = new Date(min.getTime() - offset * 60_000).toISOString().slice(0, 16);
  const current = state.plannerEditId ? state.planner.find((item) => item.id === state.plannerEditId) : null;
  if (current?.scheduledAt) {
    const scheduled = new Date(current.scheduledAt);
    input.value = new Date(scheduled.getTime() - scheduled.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  } else input.value = defaultScheduleLocalValue();
  const platforms = selectedPlatforms();
  $('scheduleSummary').innerHTML = `<strong>${escapeHtml($('title').value.trim() || $('caption').value.trim().slice(0, 70) || 'Publicação')}</strong><span>${platforms.length} rede${platforms.length === 1 ? '' : 's'} selecionada${platforms.length === 1 ? '' : 's'}</span><div>${platforms.map((platform) => `<span class="mini-network ${networks[platform]?.logoClass || ''}">${networks[platform]?.logo || '?'}</span>`).join('')}</div>`;
  $('scheduleDialog').showModal();
}

async function confirmSchedule() {
  const button = $('scheduleConfirmBtn');
  const value = $('scheduleDateTime').value;
  if (!value) return toast('Escolha a data e o horário.', 'error');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 15_000) return toast('Escolha um horário futuro.', 'error');
  button.disabled = true;
  button.textContent = 'Agendando...';
  try {
    await saveCurrentPlanner('scheduled', date.toISOString());
    $('scheduleDialog').close();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Agendar publicação <span>→</span>';
  }
}

async function deletePlanner(id) {
  const item = state.planner.find((candidate) => candidate.id === id);
  if (!item) return;
  const title = item.payload?.title || item.payload?.caption?.slice(0, 60) || 'este conteúdo';
  if (!window.confirm(`Excluir "${title}"? A mídia salva deste item também será removida.`)) return;
  const response = await apiFetch(`api/planner/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return toast(data.error || 'Não foi possível excluir.', 'error');
  if (state.plannerEditId === id) resetComposer({ silent: true });
  const refresh = await Promise.allSettled([loadPlanner()]);
  toast('Item excluído.', 'success');
  if (refresh[0]?.status === 'rejected') toast('O item foi excluído, mas a lista não pôde ser atualizada agora.', 'error');
}

async function unschedulePlanner(id) {
  const response = await apiFetch(`api/planner/${encodeURIComponent(id)}/unschedule`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return toast(data.error || 'Não foi possível cancelar o agendamento.', 'error');
  const refresh = await Promise.allSettled([loadPlanner()]);
  toast('Agendamento cancelado. O conteúdo voltou para Rascunhos.', 'success');
  if (refresh[0]?.status === 'rejected') toast('O agendamento foi cancelado, mas a lista não pôde ser atualizada agora.', 'error');
}

async function publishPlannerNow(id, { ask = true } = {}) {
  if (ask && !window.confirm('Publicar este conteúdo agora? O agendamento será consumido.')) return null;
  const response = await apiFetch(`api/planner/${encodeURIComponent(id)}/publish-now`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 207) {
    toast(data.error || 'Não foi possível publicar.', 'error');
    loadPlanner().catch(() => {});
    return null;
  }
  const refresh = await Promise.allSettled([loadPlanner(), loadHistory(), loadConfig()]);
  if (refresh.some((item) => item.status === 'rejected')) toast('O envio terminou, mas parte da tela não pôde ser atualizada agora.', 'error');
  if (data.status === 'published') toast('Publicação concluída.', 'success');
  else toast(data.lastError || 'Publicação concluída com atenção.', 'error');
  return data;
}

function bindPlannerDynamicActions(root = document) {
  root.querySelectorAll('[data-planner-edit]').forEach((button) => {
    if (button.dataset.plannerBound) return;
    button.dataset.plannerBound = '1';
    button.addEventListener('click', (event) => { event.preventDefault(); editPlannerItem(button.dataset.plannerEdit); });
  });
  root.querySelectorAll('[data-planner-delete]').forEach((button) => {
    if (button.dataset.plannerBound) return;
    button.dataset.plannerBound = '1';
    button.addEventListener('click', () => deletePlanner(button.dataset.plannerDelete));
  });
  root.querySelectorAll('[data-planner-unschedule]').forEach((button) => {
    if (button.dataset.plannerBound) return;
    button.dataset.plannerBound = '1';
    button.addEventListener('click', () => unschedulePlanner(button.dataset.plannerUnschedule));
  });
  root.querySelectorAll('[data-planner-publish-now]').forEach((button) => {
    if (button.dataset.plannerBound) return;
    button.dataset.plannerBound = '1';
    button.addEventListener('click', () => publishPlannerNow(button.dataset.plannerPublishNow));
  });
  root.querySelectorAll('[data-calendar-day]').forEach((button) => {
    if (button.dataset.plannerBound) return;
    button.dataset.plannerBound = '1';
    button.addEventListener('click', () => {
      renderCalendarAgenda(button.dataset.calendarDay);
      $('calendarUpcoming')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

function currentTemplatePayload() {
  return {
    title: $('title').value.trim(),
    caption: $('caption').value.trim(),
    mediaKind: state.kind,
    platforms: selectedPlatforms().join(','),
    networkContent: activeNetworkContent(),
    youtubePrivacy: $('youtubePrivacy').value,
    tiktokPrivacy: $('tiktokPrivacy').value,
    tiktokCommercial: $('tiktokCommercial').checked,
    tiktokBrandOrganic: $('tiktokBrandOrganic').checked,
    tiktokBrandContent: $('tiktokBrandContent').checked,
    tiktokAigc: $('tiktokAigc').checked,
    tiktokAllowComment: $('tiktokAllowComment').checked,
    tiktokAllowDuet: $('tiktokAllowDuet').checked,
    tiktokAllowStitch: $('tiktokAllowStitch').checked,
    tiktokConsent: $('tiktokConsent').checked,
  };
}

function templateNetworkLogos(template) {
  const raw = template?.payload?.platforms;
  const platforms = Array.isArray(raw) ? raw : String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  return platforms.filter((platform) => networks[platform]).map((platform) => `<span class="mini-network ${networks[platform].logoClass}" title="${escapeHtml(networks[platform].label)}">${networks[platform].logo}</span>`).join('');
}

function renderTemplateMetrics() {
  if ($('templateMetric')) $('templateMetric').textContent = String(state.templates.length);
  if ($('templateVariantMetric')) $('templateVariantMetric').textContent = String(state.templates.filter((item) => Object.keys(item.payload?.networkContent || {}).length).length);
  const all = new Set();
  state.templates.forEach((item) => {
    const raw = item.payload?.platforms;
    (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((value) => String(value).trim()).filter(Boolean).forEach((platform) => all.add(platform));
  });
  if ($('templateNetworkMetric')) $('templateNetworkMetric').textContent = String(all.size);
  if ($('templateNavCount')) { $('templateNavCount').textContent = String(state.templates.length); $('templateNavCount').classList.toggle('hidden', state.templates.length === 0); }
}

function filteredTemplates(query = state.templateFilter) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return state.templates;
  return state.templates.filter((item) => `${item.name || ''} ${item.description || ''} ${item.payload?.title || ''} ${item.payload?.caption || ''}`.toLowerCase().includes(term));
}

function renderTemplates() {
  const node = $('templateList');
  if (!node) return;
  if (state.loadErrors.templates) {
    if ($('templateMetric')) $('templateMetric').textContent = '--';
    if ($('templateVariantMetric')) $('templateVariantMetric').textContent = '--';
    if ($('templateNetworkMetric')) $('templateNetworkMetric').textContent = '--';
    node.innerHTML = loadErrorHtml('templates', 'Não foi possível carregar os templates', state.loadErrors.templates);
    return;
  }
  renderTemplateMetrics();
  const items = filteredTemplates();
  if (!state.templates.length) {
    node.innerHTML = '<div class="empty-state template-empty"><strong>Nenhum template salvo ainda.</strong><span>Monte uma publicação e clique em “Salvar como template”.</span><button type="button" data-go-page="publish">Criar primeira publicação</button></div>';
    return;
  }
  if (!items.length) {
    node.innerHTML = '<div class="empty-state compact">Nenhum template corresponde à busca.</div>';
    return;
  }
  node.innerHTML = items.map((item) => {
    const payload = item.payload || {};
    const kindLabel = payload.mediaKind === 'video' ? 'Vídeo' : payload.mediaKind === 'image' ? 'Imagem' : 'Texto';
    const variants = Object.keys(payload.networkContent || {}).length;
    return `<article class="template-card">
      <div class="template-card-icon">◫</div>
      <div class="template-card-copy"><div class="template-card-title"><strong>${escapeHtml(item.name || 'Template')}</strong><span>${escapeHtml(kindLabel)}</span></div><p>${escapeHtml(item.description || payload.caption || payload.title || 'Modelo sem descrição')}</p><div class="template-card-meta"><div>${templateNetworkLogos(item) || '<small>Sem redes pré-selecionadas</small>'}</div><span>${variants ? `${variants} variaç${variants === 1 ? 'ão' : 'ões'} por rede` : 'Usa conteúdo principal'}</span><span>Atualizado ${formatDate(item.updatedAt)}</span></div></div>
      <div class="template-card-actions"><button class="primary-action compact" type="button" data-template-use="${escapeHtml(item.id)}">Usar template</button><button class="danger-text-btn" type="button" data-template-delete="${escapeHtml(item.id)}">Excluir</button></div>
    </article>`;
  }).join('');
  bindTemplateDynamicActions(node);
}

function renderTemplatePicker(query = '') {
  const node = $('templatePickerList');
  if (!node) return;
  if (state.loadErrors.templates) {
    node.innerHTML = loadErrorHtml('templates', 'Biblioteca indisponível', state.loadErrors.templates);
    return;
  }
  const items = filteredTemplates(query);
  node.innerHTML = items.length ? items.map((item) => `<button class="template-picker-row" type="button" data-template-use="${escapeHtml(item.id)}"><span class="template-card-icon">◫</span><span><strong>${escapeHtml(item.name || 'Template')}</strong><small>${escapeHtml(item.description || item.payload?.caption || item.payload?.title || 'Modelo salvo')}</small></span><span class="template-picker-networks">${templateNetworkLogos(item)}</span><i>→</i></button>`).join('') : '<div class="empty-state compact">Nenhum template encontrado.</div>';
  bindTemplateDynamicActions(node, { closePicker: true });
}

function bindTemplateDynamicActions(root, { closePicker = false } = {}) {
  root.querySelectorAll('[data-template-use]').forEach((button) => button.addEventListener('click', () => {
    applyTemplate(button.dataset.templateUse);
    if (closePicker) $('templatePickerDialog')?.close();
  }));
  root.querySelectorAll('[data-template-delete]').forEach((button) => button.addEventListener('click', () => deleteTemplateItem(button.dataset.templateDelete)));
}

function applyTemplate(id) {
  const item = state.templates.find((template) => template.id === id);
  if (!item) return toast('Template não encontrado.', 'error');
  const payload = item.payload || {};
  if (state.plannerDirty && !window.confirm('Aplicar este template vai substituir o conteúdo atual. Continuar?')) return;
  clearMedia({ markDirty: false });
  state.plannerEditId = null;
  state.plannerExistingMedia = null;
  state.plannerRemoveMedia = false;
  state.networkContent = structuredClone(payload.networkContent || {});
  setKind(['text', 'image', 'video'].includes(payload.mediaKind) ? payload.mediaKind : 'text', { keepFile: true });
  $('title').value = payload.title || '';
  $('caption').value = payload.caption || '';
  $('mediaUrl').value = '';
  $('youtubePrivacy').value = payload.youtubePrivacy || 'private';
  ensureSelectValue($('tiktokPrivacy'), payload.tiktokPrivacy || '');
  ['tiktokCommercial', 'tiktokBrandOrganic', 'tiktokBrandContent', 'tiktokAigc', 'tiktokAllowComment', 'tiktokAllowDuet', 'tiktokAllowStitch', 'tiktokConsent'].forEach((idName) => { if ($(idName)) $(idName).checked = Boolean(payload[idName]); });
  // payload uses camel-case field names without the DOM prefix in persisted templates.
  $('tiktokCommercial').checked = Boolean(payload.tiktokCommercial);
  $('tiktokBrandOrganic').checked = Boolean(payload.tiktokBrandOrganic);
  $('tiktokBrandContent').checked = Boolean(payload.tiktokBrandContent);
  $('tiktokAigc').checked = Boolean(payload.tiktokAigc);
  $('tiktokAllowComment').checked = Boolean(payload.tiktokAllowComment);
  $('tiktokAllowDuet').checked = Boolean(payload.tiktokAllowDuet);
  $('tiktokAllowStitch').checked = Boolean(payload.tiktokAllowStitch);
  $('tiktokConsent').checked = Boolean(payload.tiktokConsent);
  $('tiktokCommercialOptions')?.classList.toggle('hidden', !$('tiktokCommercial').checked);
  updateNetworkAvailability();
  const platforms = Array.isArray(payload.platforms) ? payload.platforms : String(payload.platforms || '').split(',').map((value) => value.trim()).filter(Boolean);
  $$('input[name="platform"]').forEach((input) => { input.checked = platforms.includes(input.value) && !input.disabled; });
  state.previewPlatform = null;
  state.maxPublishStep = 3;
  setPublishStep(1, { force: true });
  markPlannerDirty();
  refreshUi();
  navigateToPage('publish');
  toast(`Template “${item.name}” aplicado. Revise o conteúdo antes de publicar.`, 'success');
}

function openTemplateSaveDialog() {
  const payload = currentTemplatePayload();
  if (!payload.title && !payload.caption) return toast('Escreva algum conteúdo antes de salvar um template.', 'error');
  const platforms = selectedPlatforms();
  $('templateNameInput').value = payload.title ? smartTrim(payload.title, 70) : smartTrim(payload.caption, 70);
  $('templateDescriptionInput').value = '';
  $('templateSaveSummary').innerHTML = `<strong>${escapeHtml(payload.title || 'Template de publicação')}</strong><span>${state.kind === 'video' ? 'Vídeo' : state.kind === 'image' ? 'Imagem' : 'Texto'} · ${platforms.length} rede${platforms.length === 1 ? '' : 's'} · ${Object.keys(state.networkContent || {}).length} variaç${Object.keys(state.networkContent || {}).length === 1 ? 'ão' : 'ões'}</span><small>A mídia não será copiada para o template.</small>`;
  $('templateSaveDialog').showModal();
  setTimeout(() => $('templateNameInput')?.focus(), 30);
}

async function saveCurrentAsTemplate() {
  const name = $('templateNameInput').value.trim();
  if (!name) return toast('Dê um nome ao template.', 'error');
  const button = $('templateSaveConfirmBtn');
  button.disabled = true;
  try {
    const response = await apiFetch('api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: $('templateDescriptionInput').value.trim(), payload: currentTemplatePayload() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível salvar o template.');
    $('templateSaveDialog').close();
    const refresh = await Promise.allSettled([loadTemplates()]);
    toast('Template salvo na biblioteca.', 'success');
    if (refresh[0]?.status === 'rejected') toast('Template salvo, mas a biblioteca não pôde ser atualizada agora.', 'error');
  } catch (error) {
    toast(error.message, 'error');
  } finally { button.disabled = false; }
}

async function deleteTemplateItem(id) {
  const item = state.templates.find((template) => template.id === id);
  if (!item || !window.confirm(`Excluir o template “${item.name}”?`)) return;
  const response = await apiFetch(`api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return toast(data.error || 'Não foi possível excluir o template.', 'error');
  const refresh = await Promise.allSettled([loadTemplates()]);
  toast('Template excluído.');
  if (refresh[0]?.status === 'rejected') toast('Template excluído, mas a biblioteca não pôde ser atualizada agora.', 'error');
}

async function loadTemplates() {
  try {
    const response = await apiFetch('api/templates', { cache: 'no-store' });
    if (!response.ok) throw new Error('Falha ao carregar templates');
    state.templates = await response.json();
    state.loadErrors.templates = null;
    renderTemplates();
    renderTemplatePicker($('templatePickerSearch')?.value || '');
    return state.templates;
  } catch (error) {
    state.loadErrors.templates = friendlyRequestError(error, 'Não foi possível carregar os templates.');
    renderTemplates();
    renderTemplatePicker($('templatePickerSearch')?.value || '');
    throw error;
  }
}

async function loadPlanner() {
  try {
    const response = await apiFetch('api/planner?limit=500', { cache: 'no-store' });
    if (!response.ok) throw new Error('Falha ao carregar rascunhos e agendamentos');
    state.planner = await response.json();
    state.loadErrors.planner = null;
    renderPlannerSurfaces();
    return state.planner;
  } catch (error) {
    state.loadErrors.planner = friendlyRequestError(error, 'Não foi possível carregar rascunhos e agendamentos.');
    renderPlannerSurfaces();
    throw error;
  }
}

async function loadConfig() {
  const response = await apiFetch('api/config', { cache: 'no-store' });
  if (response.status === 401) throw new Error('Sua sessão do Workspace expirou. Entre novamente para continuar.');
  if (!response.ok) throw new Error('Não foi possível carregar a configuração do Social Publisher.');
  state.config = await response.json();
  const user = state.config.user || {};
  applyAccessControl();
  if ($('sidebarUserName')) $('sidebarUserName').textContent = user.name || 'Social Publisher';
  if ($('sidebarUserEmail')) $('sidebarUserEmail').textContent = user.email || 'Conta do Workspace';
  if ($('sidebarAvatar')) {
    const initials = String(user.name || 'Social Publisher').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    $('sidebarAvatar').textContent = initials || 'SP';
  }
  const demo = state.config.demoMode;
  $('modeBadge').textContent = demo ? 'MODO DEMO' : 'MODO REAL';
  $('modeBadge').className = `badge ${demo ? 'demo' : 'real'}`;
  $('sideMode').textContent = demo ? 'Modo Demo ativo' : 'Modo Real ativo';
  if ($('docsDate')) $('docsDate').textContent = `Docs: ${state.config.docsVerifiedAt}`;
  $('verifiedDate').textContent = state.config.docsVerifiedAt;
  $('metaVersion').textContent = state.config.apiVersions?.instagramGraph || state.config.apiVersions?.metaGraph || '--';
  $('linkedinVersion').textContent = state.config.apiVersions?.linkedin || '--';
  renderConnections();
  renderMetrics();
  if (state.settings) {
    populateFacebookPages(state.settings.facebook?.pageId || '');
    populateGoogleBusinessLocations(state.settings.googleBusiness?.locationName || '');
  }
  renderAdminIntegrationState();
  updateAdminPublicLinks();
  await loadTikTokCreatorInfo();
  refreshUi();
}

async function loadHistory() {
  try {
    const response = await apiFetch('api/history?limit=100', { cache: 'no-store' });
    if (!response.ok) throw new Error('Falha ao carregar histórico');
    state.history = await response.json();
    state.loadErrors.history = null;
    renderHistory();
    renderDashboard();
    return state.history;
  } catch (error) {
    state.loadErrors.history = friendlyRequestError(error, 'Não foi possível carregar o histórico.');
    renderHistory();
    renderDashboard();
    throw error;
  }
}

async function retryLoadScope(scope) {
  const loaders = { history: loadHistory, planner: loadPlanner, templates: loadTemplates };
  const loader = loaders[scope];
  if (!loader) return;
  try {
    await loader();
    toast('Dados carregados novamente.', 'success');
  } catch (error) {
    toast(friendlyRequestError(error), 'error');
  }
}

async function refreshAllData({ quiet = false } = {}) {
  await loadConfig();
  const core = await Promise.allSettled([loadHistory(), loadPlanner(), loadTemplates()]);
  if (state.canAdmin) await Promise.allSettled([loadSettings(), loadDiagnostics({ silent: true })]);
  const failures = core.filter((result) => result.status === 'rejected');
  if (failures.length && !quiet) toast('Algumas áreas não puderam ser atualizadas. Você pode tentar novamente nos avisos exibidos.', 'error');
  if (!failures.length && !quiet) toast('Dados atualizados.', 'success');
  return failures;
}

async function publish(event) {
  event.preventDefault();
  if (state.publishing) return;
  refreshUi();
  const checks = buildPreflight();
  const blockers = checks.filter((check) => check.status !== 'ok');
  if (blockers.length) {
    setAlert(friendlyCheckDetail(blockers[0]), 'error');
    return;
  }

  state.publishing = true;
  setAlert('Enviando para as redes selecionadas. Você pode acompanhar o andamento abaixo.', 'info');
  renderPublishProgress(null, true);
  $('publishBtnText').textContent = 'Publicando...';
  $('publishBtnIcon').textContent = '◌';
  $('publishBtn').classList.add('loading');
  refreshUi();

  try {
    let data;
    if (state.plannerEditId) {
      const saved = await saveCurrentPlanner('draft', null, { navigateAfter: false, quiet: true });
      const response = await apiFetch(`api/planner/${encodeURIComponent(saved.id)}/publish-now`, { method: 'POST' });
      data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) {
        const requestError = new Error(data.error || 'Falha ao publicar.');
        requestError.publishDetails = data;
        throw requestError;
      }
      renderPublishProgress(data.results || {}, false);
      if (data.status === 'published') {
        const successes = Object.values(data.results || {}).filter((result) => result.status === 'success').length;
        setAlert(`Publicação concluída em ${successes} rede(s).`, 'success');
        toast('Publicação concluída.', 'success');
        state.plannerEditId = null;
        state.plannerExistingMedia = null;
        $('plannerEditBanner')?.classList.add('hidden');
        markPlannerSaved('Publicado agora');
      } else {
        const results = Object.values(data.results || {});
        const successes = results.filter((result) => result.status === 'success').length;
        const errors = results.filter((result) => result.status === 'error').length;
        setAlert(data.lastError || `${successes} rede(s) concluída(s); ${errors} precisam de atenção.`, 'error');
        toast('Publicação concluída com atenção.', 'error');
      }
      const refresh = await Promise.allSettled([loadPlanner(), loadHistory(), loadConfig()]);
      if (refresh.some((item) => item.status === 'rejected')) toast('Publicação concluída, mas parte da tela não pôde ser atualizada agora.', 'error');
    } else {
      const response = await apiFetch('api/publish', { method: 'POST', body: publicationFormData() });
      data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const details = Array.isArray(data.details) ? ` ${data.details.join(' · ')}` : '';
        const requestError = new Error(`${data.error || 'Falha ao publicar.'}${details}`);
        requestError.publishDetails = data;
        throw requestError;
      }

      const results = Object.entries(data.results || {});
      const successes = results.filter(([, result]) => result.status === 'success').length;
      const errors = results.filter(([, result]) => result.status === 'error');
      renderPublishProgress(data.results || {}, false);
      if (errors.length) {
        setAlert(`${successes} rede(s) concluida(s); ${errors.length} falharam. Veja o histórico.`, 'error');
        toast('Publicação concluída com falhas em algumas redes.', 'error');
      } else {
        setAlert(`${data.demoMode ? 'Simulação' : 'Publicação'} concluída em ${successes} rede(s).`, 'success');
        toast(data.demoMode ? 'Simulação concluída.' : 'Publicação concluída.', 'success');
      }
      const refresh = await Promise.allSettled([loadHistory(), loadConfig(), loadPlanner()]);
      if (refresh.some((item) => item.status === 'rejected')) toast('Publicação concluída, mas parte da tela não pôde ser atualizada agora.', 'error');
    }
  } catch (error) {
    const message = friendlyRequestError(error);
    const uncertain = /não foi possível comunicar|demorou demais|tempo limite|temporariamente indisponível/i.test(message);
    const safeMessage = uncertain
      ? 'A comunicação foi interrompida durante o envio. Antes de tentar novamente, confira Publicações e as próprias redes para evitar conteúdo duplicado.'
      : message;
    setAlert(safeMessage, 'error');
    const technical = error?.publishDetails || {};
    const failed = Object.fromEntries(selectedPlatforms().map((platform) => [platform, {
      status: 'error',
      message: uncertain ? 'Resultado incerto — confira antes de reenviar.' : message,
      code: technical.code || null,
      stage: technical.stage || null,
      attemptId: technical.attemptId || null,
      requestId: technical.requestId || null,
      logId: technical.logId || null,
      reason: technical.reason || null,
      apiStatus: technical.apiStatus || null,
      apiCode: technical.apiCode || null,
      httpStatus: technical.httpStatus || null,
    }]));
    renderPublishProgress(failed, false);
    toast(safeMessage, 'error');
    if (uncertain) loadHistory().catch(() => {});
  } finally {
    state.publishing = false;
    $('publishBtnText').textContent = 'Publicar agora';
    $('publishBtnIcon').textContent = '↗';
    $('publishBtn').classList.remove('loading');
    refreshUi();
  }
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;
  $$('.type-btn').forEach((button) => button.addEventListener('click', () => { setKind(button.dataset.kind); markPlannerDirty(); }));
  $$('input[name="platform"]').forEach((input) => input.addEventListener('change', () => { markPlannerDirty(); renderPublishProgress(); refreshUi(); }));
  ['title', 'caption'].forEach((id) => $(id).addEventListener('input', () => { markPlannerDirty(); renderPublishProgress(); refreshUi(); }));
  $('tiktokPrivacy').addEventListener('change', () => { markPlannerDirty(); refreshUi(); });
  $('tiktokCommercial').addEventListener('change', () => {
    markPlannerDirty();
    $('tiktokCommercialOptions').classList.toggle('hidden', !$('tiktokCommercial').checked);
    refreshUi();
  });
  ['tiktokBrandOrganic', 'tiktokBrandContent', 'tiktokAigc', 'tiktokAllowComment', 'tiktokAllowDuet', 'tiktokAllowStitch', 'tiktokConsent', 'youtubePrivacy'].forEach((id) => $(id).addEventListener('change', () => { markPlannerDirty(); refreshUi(); }));

  $('selectAllBtn').addEventListener('click', () => {
    $$('[data-platform-card]').forEach((card) => {
      const input = card.querySelector('input');
      if (!input.disabled) input.checked = true;
    });
    markPlannerDirty();
    refreshUi();
  });

  $('media').addEventListener('change', (event) => setFile(event.target.files?.[0]));
  $('dropzone').addEventListener('click', (event) => {
    if (event.target.closest('video')) return;
    $('media').click();
  });
  $('dropzone').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('media').click();
    }
  });
  ['dragenter', 'dragover'].forEach((name) => $('dropzone').addEventListener(name, (event) => {
    event.preventDefault();
    $('dropzone').classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((name) => $('dropzone').addEventListener(name, (event) => {
    event.preventDefault();
    $('dropzone').classList.remove('dragging');
  }));
  $('dropzone').addEventListener('drop', (event) => setFile(event.dataTransfer?.files?.[0]));
  $('clearMediaBtn').addEventListener('click', clearMedia);
  $$('[data-wizard-next]').forEach((button) => button.addEventListener('click', () => setPublishStep(state.publishStep + 1)));
  $$('[data-wizard-prev]').forEach((button) => button.addEventListener('click', () => setPublishStep(state.publishStep - 1, { force: true })));
  $$('[data-publish-step-target]').forEach((button) => button.addEventListener('click', () => setPublishStep(Number(button.dataset.publishStepTarget))));
  $('previewPlatformTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preview-platform]');
    if (!button) return;
    state.previewPlatform = button.dataset.previewPlatform;
    updatePreview();
  });
  $('generateVariantsBtn')?.addEventListener('click', generateNetworkVariants);
  $('resetVariantsBtn')?.addEventListener('click', resetNetworkVariants);
  $('openTemplatePickerBtn')?.addEventListener('click', () => { renderTemplatePicker(''); if ($('templatePickerSearch')) $('templatePickerSearch').value = ''; $('templatePickerDialog')?.showModal(); });
  $('saveAsTemplateBtn')?.addEventListener('click', openTemplateSaveDialog);
  $('templateFromCurrentBtn')?.addEventListener('click', openTemplateSaveDialog);
  $('templateSaveConfirmBtn')?.addEventListener('click', saveCurrentAsTemplate);
  $('templateSearch')?.addEventListener('input', (event) => { state.templateFilter = event.target.value; renderTemplates(); });
  $('templatePickerSearch')?.addEventListener('input', (event) => renderTemplatePicker(event.target.value));
  $('publishForm').addEventListener('submit', publish);
  const saveDraftAction = async (button) => {
    button.disabled = true;
    const original = button.innerHTML;
    button.textContent = 'Salvando...';
    try {
      const current = state.plannerEditId ? state.planner.find((item) => item.id === state.plannerEditId) : null;
      if (current?.status === 'scheduled' && current.scheduledAt) {
        await saveCurrentPlanner('scheduled', current.scheduledAt, { navigateAfter: false });
      } else {
        await saveCurrentPlanner('draft', null, { navigateAfter: false });
      }
    }
    catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; button.innerHTML = original; }
  };
  $('saveDraftTopBtn')?.addEventListener('click', () => saveDraftAction($('saveDraftTopBtn')));
  $('saveDraftBtn')?.addEventListener('click', () => saveDraftAction($('saveDraftBtn')));
  $('openScheduleBtn')?.addEventListener('click', openScheduleDialog);
  $('scheduleConfirmBtn')?.addEventListener('click', confirmSchedule);
  $('plannerEditCloseBtn')?.addEventListener('click', beginNewPublication);
  $('settingsForm').addEventListener('submit', (event) => event.preventDefault());
  $$('[data-save-settings]').forEach((button) => button.addEventListener('click', () => saveSettingsSection(button.dataset.saveSettings, button)));
  $$('[data-admin-tab-target]').forEach((button) => button.addEventListener('click', () => setAdminTab(button.dataset.adminTabTarget)));
  $('runDiagnosticsBtn')?.addEventListener('click', () => loadDiagnostics().catch((error) => toast(error.message, 'error')));
  $('copyDiagnosticsBtn')?.addEventListener('click', () => copyDiagnostics().catch((error) => toast(error.message, 'error')));
  $('settingsDemoMode').addEventListener('change', updateSettingsModeBadge);
  $('settingsAppBaseUrl').addEventListener('input', updateCallbackPreviews);
  $('settingsGoogleBusinessUseYoutube').addEventListener('change', updateGoogleBusinessCredentialFields);
  $$('[data-copy]').forEach((button) => button.addEventListener('click', () => copyTextFrom(button.dataset.copy)));
  $$('[data-clear-credentials]').forEach((button) => button.addEventListener('click', () => clearCredentials(button.dataset.clearCredentials)));
  $$('[data-reveal]').forEach((button) => button.addEventListener('click', () => {
    const input = $(button.dataset.reveal);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.classList.toggle('active', input.type === 'text');
  }));
  $$('[data-page-target]').forEach((item) => item.addEventListener('click', () => {
    if (item.dataset.pageTarget === 'publish') beginNewPublication();
    else navigateToPage(item.dataset.pageTarget);
  }));
  document.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry-load]');
    if (retry) {
      event.preventDefault();
      retryLoadScope(retry.dataset.retryLoad);
      return;
    }
    const trigger = event.target.closest('[data-go-page]');
    if (!trigger) return;
    event.preventDefault();
    if (trigger.dataset.goPage === 'publish') {
      beginNewPublication();
      return;
    }
    navigateToPage(trigger.dataset.goPage);
    if (trigger.dataset.goPage === 'admin' && state.canAdmin) {
      setAdminTab('integrations');
      const platform = trigger.dataset.configurePlatform;
      if (platform) {
        const card = document.querySelector(`[data-platform-settings="${platform}"]`);
        if (card) {
          card.open = true;
          setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 40);
        }
      }
    }
  });
  window.addEventListener('hashchange', () => navigateToPage(window.location.hash, { updateHash: false }));
  $('headerPrimaryAction')?.addEventListener('click', beginNewPublication);
  $('mobileMenuBtn')?.addEventListener('click', () => setSidebarOpen(true));
  $('mobileSidebarClose')?.addEventListener('click', () => setSidebarOpen(false));
  $('sidebarBackdrop')?.addEventListener('click', () => setSidebarOpen(false));

  $('calendarPrevBtn')?.addEventListener('click', () => { state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1); renderCalendar(); });
  $('calendarNextBtn')?.addEventListener('click', () => { state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1); renderCalendar(); });
  $('calendarTodayBtn')?.addEventListener('click', () => { const now = new Date(); state.calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1); renderCalendar(); });
  $('draftSearch')?.addEventListener('input', (event) => { state.draftFilters.query = event.target.value; renderDrafts(); });
  $('draftStatusFilter')?.addEventListener('change', (event) => { state.draftFilters.status = event.target.value; renderDrafts(); });

  $('historySearch')?.addEventListener('input', (event) => {
    state.historyFilters.query = event.target.value;
    renderHistory();
  });
  $('historyPlatformFilter')?.addEventListener('change', (event) => {
    state.historyFilters.platform = event.target.value;
    renderHistory();
  });
  $('historyStatusFilter')?.addEventListener('change', (event) => {
    state.historyFilters.status = event.target.value;
    renderHistory();
  });
  $('historyKindFilter')?.addEventListener('change', (event) => {
    state.historyFilters.kind = event.target.value;
    renderHistory();
  });
  $('clearHistoryFilters')?.addEventListener('click', clearHistoryFilters);
  $('connectionsRefreshBtn')?.addEventListener('click', async () => {
    const button = $('connectionsRefreshBtn');
    button.disabled = true;
    button.textContent = '↻ Atualizando...';
    try {
      await loadConfig();
      toast('Status das contas atualizado.', 'success');
    } catch (error) {
      toast(friendlyRequestError(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = '↻ Atualizar status';
    }
  });

  $('refreshBtn').addEventListener('click', async () => {
    $('refreshBtn').classList.add('spinning');
    $('refreshBtn').disabled = true;
    try {
      await refreshAllData();
    } catch (error) {
      toast(friendlyRequestError(error), 'error');
    } finally {
      $('refreshBtn').disabled = false;
      setTimeout(() => $('refreshBtn').classList.remove('spinning'), 350);
    }
  });

  $('connectivityRetryBtn')?.addEventListener('click', async () => {
    if ($('connectivityBanner')?.classList.contains('session')) {
      window.location.assign('logout');
      return;
    }
    try {
      await refreshAllData({ quiet: true });
      setConnectivityState('online');
      toast('Conexão restabelecida e dados atualizados.', 'success');
    } catch (error) {
      toast(friendlyRequestError(error), 'error');
    }
  });
  $('appBootRetryBtn')?.addEventListener('click', () => init({ retry: true }));
  window.addEventListener('offline', () => setConnectivityState('offline'));
  window.addEventListener('online', () => {
    setConnectivityState('degraded', 'A conexão voltou. Atualize os dados para confirmar que tudo está sincronizado.');
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.plannerDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function init({ retry = false } = {}) {
  bindEvents();
  setBootState('loading', retry ? 'Tentando conectar novamente...' : 'Carregando contas, publicações e planejamento...');
  try {
    await loadConfig();
  } catch (error) {
    const message = friendlyRequestError(error, 'Não foi possível carregar a configuração do Social Publisher.');
    setBootState('error', message);
    return;
  }

  setKind('text', { keepFile: true });
  setPublishStep(1, { force: true });
  markPlannerSaved('Novo conteúdo');

  const secondary = await Promise.allSettled([loadHistory(), loadPlanner(), loadTemplates()]);
  if (state.canAdmin) await Promise.allSettled([loadSettings(), loadDiagnostics({ silent: true })]);
  if (secondary.some((result) => result.status === 'rejected')) {
    toast('O sistema abriu, mas algumas áreas não puderam ser carregadas. Use “Tentar novamente” onde aparecer o aviso.', 'error');
  }

  const params = new URLSearchParams(window.location.search);
  const connectedPlatform = params.get('connected');
  if (connectedPlatform) toast(`${networks[connectedPlatform]?.label || 'Conta'} conectada com sucesso.`, 'success');
  if (params.get('error')) toast(friendlyIssue(params.get('error')) || 'Não foi possível concluir a conexão da conta.', 'error');

  const initialPage = connectedPlatform ? 'connections' : normalizePage(window.location.hash);
  if (params.has('connected') || params.has('error') || !window.location.hash) {
    window.history.replaceState({}, '', `${window.location.pathname}#${initialPage}`);
  }
  if (state.canAdmin) setAdminTab(state.adminTab);
  navigateToPage(initialPage, { updateHash: false, scroll: false });
  setBootState('ready');
  if (!navigator.onLine) setConnectivityState('offline');
}

init();
