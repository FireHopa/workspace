import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import {
  connectionSummary,
  getFacebookAuthUrl,
  getGoogleBusinessAuthUrl,
  getInstagramAuthUrl,
  getLinkedInAuthUrl,
  getTikTokAuthUrl,
  getTikTokCreatorInfo,
  getYouTubeAuthUrl,
  handleFacebookCallback,
  handleGoogleBusinessCallback,
  handleInstagramCallback,
  handleLinkedInCallback,
  handleTikTokCallback,
  handleYouTubeCallback,
  publishFacebook,
  publishGoogleBusiness,
  publishInstagram,
  publishLinkedIn,
  publishTikTok,
  publishYouTube,
} from './providers.js';
import {
  addHistory,
  claimDuePlannerItems,
  claimPlannerItem,
  clearPlatformToken,
  deletePlannerItem,
  deleteTemplate,
  getHistory,
  getPlannerItem,
  getPlannerItems,
  getTemplate,
  getTemplates,
  recoverInterruptedPlannerItems,
  savePlannerItem,
  saveTemplate,
} from './store.js';
import { getRuntimeConfig, getSafeSettings, updateSettings } from './config.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(srcDir, '..');
dotenv.config({ path: path.resolve(projectRoot, '..', '.env') });
dotenv.config({ path: path.join(projectRoot, '.env'), override: false });

const app = express();
const bootConfig = getRuntimeConfig();
const port = bootConfig.port;
const maxUploadMb = bootConfig.maxUploadMb;
const uploadsDir = path.join(projectRoot, 'uploads');
const publicDir = path.join(projectRoot, 'public');
const legalDir = path.join(projectRoot, 'legal');
const dataDir = path.join(projectRoot, 'data');
const publishErrorLogPath = path.join(dataDir, 'publish-errors.ndjson');
const workspaceRoot = path.resolve(projectRoot, '..');
const normalizeBasePath = (value) => {
  const clean = String(value || '/social').trim().replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '/social';
};
const basePath = normalizeBasePath(process.env.SOCIAL_BASE_PATH);
const workspaceUpstream = new URL(process.env.WORKSPACE_UPSTREAM || 'http://127.0.0.1:8001');
const socialCookieName = 'workspace_social_session';
const returnCookieName = 'workspace_social_return';
const oauthStates = new Map();
const docsVerifiedAt = '2026-09-23';

const platformRules = {
  youtube: {
    label: 'YouTube',
    mediaKinds: ['video'],
    requiresLocalFile: true,
    titleMax: 100,
    descriptionMaxBytes: 5000,
    note: 'Upload de video via sessao resumivel.',
  },
  instagram: {
    label: 'Instagram',
    mediaKinds: ['image', 'video'],
    requiresPublicMediaUrl: true,
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    videoMaxBytes: 300 * 1024 * 1024,
    videoDurationMinSec: 3,
    videoDurationMaxSec: 15 * 60,
    videoMaxWidth: 1920,
    captionMax: 2200,
    imageMimeTypes: ['image/jpeg'],
    note: 'Login direto do Instagram para conta Business/Creator. JPEG para imagem; arquivo local exige URL publica.',
  },
  linkedin: {
    label: 'LinkedIn',
    mediaKinds: ['text', 'image', 'video'],
    localFileForMedia: true,
    commentaryMax: 3000,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    videoMimeTypes: ['video/mp4'],
    videoMinBytes: 75 * 1024,
    videoMaxBytes: 500 * 1024 * 1024,
    videoDurationMinSec: 3,
    videoDurationMaxSec: 30 * 60,
    note: 'Posts API + Images/Videos API versionadas.',
  },
  tiktok: {
    label: 'TikTok',
    mediaKinds: ['image', 'video'],
    videoMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    videoMaxBytes: 4 * 1024 * 1024 * 1024,
    videoMinWidth: 360,
    videoMaxWidth: 4096,
    captionMax: 2200,
    photoDescriptionMax: 4000,
    requiresVerifiedPhotoUrl: true,
    imageMimeTypes: ['image/jpeg', 'image/webp'],
    imageMaxBytes: 20 * 1024 * 1024,
    imageMaxDimension: 1080,
    note: 'Content Posting API. Apps nao auditados publicam em modo privado.',
  },
  facebook: {
    label: 'Facebook',
    mediaKinds: ['text', 'image', 'video'],
    imageRequiresPublicUrl: true,
    videoRequiresLocalFile: true,
    reelDurationMinSec: 3,
    reelDurationMaxSec: 90,
    reelMinWidth: 540,
    reelMinHeight: 960,
    reelAspectRatio: '9:16',
    note: 'Publica em Pagina do Facebook gerenciada pela conta conectada.',
  },
  googleBusiness: {
    label: 'Google Meu Negocio',
    mediaKinds: ['text', 'image'],
    imageRequiresPublicUrl: true,
    note: 'Google Business Profile Local Posts. O projeto Google precisa de aprovacao para a API.',
  },
};

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
try {
  fs.closeSync(fs.openSync(publishErrorLogPath, 'a', 0o600));
  fs.chmodSync(publishErrorLogPath, 0o600);
} catch (error) {
  console.error('[social-publisher][publish-log] Falha ao preparar arquivo de log:', error?.message || error);
}

function plannerReservedUploadNames(now = Date.now()) {
  const reserved = new Set();
  for (const item of getPlannerItems(1000)) {
    const name = item?.media?.storedFileName;
    if (!name) continue;
    const active = ['draft', 'scheduled', 'processing', 'failed', 'partial', 'needs_review'].includes(item.status);
    const retained = item.status === 'published' && item.mediaRetainUntil && new Date(item.mediaRetainUntil).getTime() > now;
    if (active || retained) reserved.add(name);
  }
  return reserved;
}

function cleanupStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const reserved = plannerReservedUploadNames(now);
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name === '.gitkeep' || reserved.has(name)) continue;
    const filePath = path.join(uploadsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
    } catch {
      // Stale-file cleanup is best-effort.
    }
  }
}

// Se o processo anterior caiu enquanto publicava um agendamento, nao tentamos
// repetir automaticamente ao subir: isso poderia duplicar posts nas redes.
recoverInterruptedPlannerItems(0);
cleanupStaleUploads();
const cleanupTimer = setInterval(() => cleanupStaleUploads(), 60 * 60 * 1000);
cleanupTimer.unref();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(allowed ? null : new Error('Envie apenas arquivo de imagem ou video'), allowed);
  },
});

app.disable('x-powered-by');
app.set('trust proxy', true);

function isSocialPath(pathname) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function cookieMap(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}

function signingKey() {
  const configured = String(process.env.SECRET_KEY || '').trim();
  if (configured && configured !== 'chave_fallback_insegura_apenas_para_dev') return configured;
  const keyPath = path.join(workspaceRoot, '.jwt_secret_key');
  try {
    const value = fs.readFileSync(keyPath, 'utf8').trim();
    if (value) return value;
  } catch {
    // FastAPI cria este arquivo automaticamente quando SECRET_KEY nao foi configurada.
  }
  throw new Error('Chave JWT do Workspace ainda nao esta disponivel');
}

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function verifyWorkspaceToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Sessao invalida');
  const header = decodeBase64UrlJson(parts[0]);
  if (header.alg !== 'HS256') throw new Error('Algoritmo JWT invalido');
  const expected = crypto.createHmac('sha256', signingKey()).update(`${parts[0]}.${parts[1]}`).digest();
  const provided = Buffer.from(parts[2], 'base64url');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error('Assinatura JWT invalida');
  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) throw new Error('Sessao expirada');
  if (!['social_publisher', 'social_publisher_admin'].includes(payload.role)) throw new Error('Conta sem acesso ao Social Publisher');
  return payload;
}

function isHttpsRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function cookieOptions(req, maxAgeMs) {
  return {
    httpOnly: true,
    secure: isHttpsRequest(req),
    sameSite: 'lax',
    // Use / porque o proxy publico pode acrescentar um prefixo (ex.: /api/social)
    // que nao existe dentro deste processo Node.
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

function safeReturnUrl(value) {
  const raw = String(value || process.env.WORKSPACE_FRONTEND_URL || '/').trim();
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw);
    if (['http:', 'https:'].includes(parsed.protocol)) return parsed.toString();
  } catch {
    // Fallback abaixo.
  }
  return '/';
}

function safeModuleBaseUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function logoutTarget(req) {
  const stored = cookieMap(req)[returnCookieName];
  const target = safeReturnUrl(stored);
  try {
    const fallbackOrigin = `${isHttpsRequest(req) ? 'https' : 'http'}://${req.get('host')}`;
    const url = new URL(target, fallbackOrigin);
    url.searchParams.set('workspace_logout', '1');
    return url.toString();
  } catch {
    return '/?workspace_logout=1';
  }
}

function proxyWorkspace(req, res) {
  const transport = workspaceUpstream.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  headers.host = workspaceUpstream.host;
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const incomingFor = String(req.headers['x-forwarded-for'] || '').trim();
  const remote = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = incomingFor ? `${incomingFor}, ${remote}` : remote;

  const base = workspaceUpstream.pathname === '/' ? '' : workspaceUpstream.pathname.replace(/\/$/, '');
  const proxyReq = transport.request({
    protocol: workspaceUpstream.protocol,
    hostname: workspaceUpstream.hostname,
    port: workspaceUpstream.port || undefined,
    method: req.method,
    path: `${base}${req.originalUrl}`,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (error) => {
    if (!res.headersSent) res.status(502).json({ detail: `Workspace indisponivel: ${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxyReq);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (req.path.startsWith(`${basePath}/api/`)) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Tudo que nao pertence ao modulo social continua exatamente no FastAPI antigo.
// O pipe preserva streaming de uploads e respostas sem carregar arquivos inteiros na memoria.
app.use((req, res, next) => {
  if (isSocialPath(req.path)) return next();
  return proxyWorkspace(req, res);
});

app.post(`${basePath}/session`, express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  try {
    const token = String(req.body?.workspace_token || '');
    const user = verifyWorkspaceToken(token);
    const moduleBaseUrl = safeModuleBaseUrl(req.body?.module_base_url);
    if (moduleBaseUrl) process.env.SOCIAL_PUBLISHER_BASE_URL = moduleBaseUrl;
    const remainingMs = Math.max(1, (Number(user.exp) * 1000) - Date.now());
    res.cookie(socialCookieName, token, cookieOptions(req, remainingMs));
    res.cookie(returnCookieName, safeReturnUrl(req.body?.return_to), cookieOptions(req, remainingMs));
    const destination = moduleBaseUrl || getRuntimeConfig().appBaseUrl;
    return res.redirect(303, `${destination}/`);
  } catch (error) {
    return res.status(401).send(`Nao foi possivel abrir o Social Publisher: ${error.message}`);
  }
});

function clearSocialCookies(req, res) {
  const options = cookieOptions(req);
  res.clearCookie(socialCookieName, options);
  res.clearCookie(returnCookieName, options);
}

app.post(`${basePath}/logout`, express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  const target = logoutTarget(req);
  clearSocialCookies(req, res);
  return res.redirect(303, target);
});
app.get(`${basePath}/logout`, (req, res) => {
  const target = logoutTarget(req);
  clearSocialCookies(req, res);
  return res.redirect(303, target);
});

// Paginas legais sao publicas de proposito: TikTok e demais plataformas precisam
// conseguir abri-las durante revisao sem uma sessao do Workspace.
app.get(`${basePath}/about`, (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(path.join(legalDir, 'about.html'));
});
app.get(`${basePath}/terms`, (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(path.join(legalDir, 'terms.html'));
});
app.get(`${basePath}/privacy`, (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.sendFile(path.join(legalDir, 'privacy.html'));
});
app.use(`${basePath}/legal-assets`, express.static(legalDir, {
  dotfiles: 'deny',
  etag: true,
  maxAge: '1h',
  index: false,
}));

// Midia temporaria precisa ser publica para Meta/TikTok/Google buscarem o arquivo.
app.use(`${basePath}/uploads`, express.static(uploadsDir, { dotfiles: 'deny', etag: false, maxAge: 0 }));

app.use(basePath, (req, res, next) => {
  const token = cookieMap(req)[socialCookieName];
  try {
    req.socialUser = verifyWorkspaceToken(token);
    return next();
  } catch (error) {
    clearSocialCookies(req, res);
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: error.message });
    return res.redirect(303, logoutTarget(req));
  }
});

// Express usa roteamento nao estrito por padrao: uma rota declarada como /social
// tambem pode casar com /social/. Se redirecionarmos os dois casos para a URL
// publica terminada em /, /social/ entra em redirect para ele mesmo (loop 308).
// Canonicalizamos SOMENTE a requisicao que realmente chegou sem a barra final.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  if (pathname !== basePath) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, `${getRuntimeConfig().appBaseUrl}/`);
});
app.use(basePath, express.json({ limit: '1mb' }));
app.use(basePath, express.urlencoded({ extended: true, limit: '1mb' }));
app.use(basePath, express.static(publicDir, { dotfiles: 'deny' }));

function newState(platform) {
  for (const [key, value] of oauthStates.entries()) {
    if (value.expiresAt < Date.now()) oauthStates.delete(key);
  }
  const value = crypto.randomBytes(32).toString('hex');
  oauthStates.set(value, { platform, expiresAt: Date.now() + 10 * 60 * 1000 });
  return value;
}

function validateState(state, platform) {
  const item = oauthStates.get(String(state || ''));
  oauthStates.delete(String(state || ''));
  if (!item || item.platform !== platform || item.expiresAt < Date.now()) {
    throw new Error('Estado OAuth invalido ou expirado. Tente conectar novamente.');
  }
}

function privateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (['localhost', '0.0.0.0', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^(fc|fd|fe80)/i.test(host)) return true;
  return false;
}

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function isPublicHttpUrl(value) {
  const url = parseHttpUrl(value);
  return Boolean(url && !privateHostname(url.hostname));
}

function publicUrlForFile(file) {
  if (!file) return null;
  return `${getRuntimeConfig().publicBaseUrl}/uploads/${encodeURIComponent(file.filename)}`;
}

function formatError(error) {
  const data = error?.response?.data;
  const apiMessage = data?.error?.message || data?.message || data?.error_description;
  return apiMessage || error?.message || String(error);
}

function platformErrorResult(error, platform) {
  const data = error?.response?.data || {};
  const apiError = data?.error || {};
  const result = { status: 'error', message: formatError(error) };
  const code = error?.code || apiError?.code || data?.code;
  const logId = error?.logId || apiError?.log_id || apiError?.logid || data?.log_id || data?.logid;
  const httpStatus = error?.status || error?.response?.status;
  if (code) result.code = String(code);
  if (logId) result.logId = String(logId);
  if (httpStatus) result.httpStatus = Number(httpStatus);
  if (error?.stage) result.stage = String(error.stage);
  if (error?.publishId) result.publishId = String(error.publishId);
  if (error?.reason) result.reason = String(error.reason);
  if (error?.apiStatus) result.apiStatus = String(error.apiStatus);
  if (error?.apiCode) result.apiCode = Number(error.apiCode);
  if (error?.domain) result.domain = String(error.domain);
  if (error?.location) result.location = String(error.location);
  if (error?.requestId) result.requestId = String(error.requestId);
  if (error?.chunkStart != null) result.chunkStart = Number(error.chunkStart);
  if (error?.chunkEnd != null) result.chunkEnd = Number(error.chunkEnd);
  if (platform) result.platform = platform;
  return result;
}

function appendPublishErrorLog(record) {
  try {
    fs.appendFileSync(publishErrorLogPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    const maxBytes = 2 * 1024 * 1024;
    if (fs.statSync(publishErrorLogPath).size > maxBytes) {
      const lines = fs.readFileSync(publishErrorLogPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500);
      fs.writeFileSync(publishErrorLogPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (logError) {
    console.error('[social-publisher][publish-log] Falha ao persistir log:', logError?.message || logError);
  }
}

function logPlatformPublishError({ platform, error, attemptId, source, plannerId, payload, file, durationMs }) {
  const result = platformErrorResult(error, platform);
  result.attemptId = attemptId;
  const record = {
    timestamp: new Date().toISOString(),
    attemptId,
    platform,
    source: source || 'unknown',
    plannerId: plannerId || null,
    mediaKind: payload?.mediaKind || null,
    fileName: file?.originalname || null,
    fileSize: file?.size || null,
    durationMs: Number(durationMs || 0),
    message: result.message || null,
    code: result.code || null,
    reason: result.reason || null,
    apiStatus: result.apiStatus || null,
    apiCode: result.apiCode || null,
    httpStatus: result.httpStatus || null,
    stage: result.stage || null,
    requestId: result.requestId || null,
    logId: result.logId || null,
    publishId: result.publishId || null,
    domain: result.domain || null,
    location: result.location || null,
  };
  console.error(`[social-publisher][publish:error][${platform}][${attemptId}] ${JSON.stringify(record)}`);
  appendPublishErrorLog(record);
  return result;
}

function requestedPlatformsFromBody(body = {}) {
  return [...new Set(String(body?.platforms || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function logPublishPipelineError({ error, req = null, file = null, stage = null, source = 'manual' }) {
  const attemptId = crypto.randomUUID();
  const platforms = requestedPlatformsFromBody(req?.body || {});
  const generic = platformErrorResult(error);
  const resolvedStage = String(stage || error?.stage || (error?.preflight ? 'preflight' : 'publish_pipeline'));
  const resolvedCode = String(generic.code || (error?.preflight ? 'PREFLIGHT_FAILED' : 'PUBLISH_PIPELINE_ERROR'));
  const httpStatus = Number(error?.statusCode || generic.httpStatus || 500);
  const mediaKind = String(req?.body?.mediaKind || '').trim() || (file?.mimetype?.startsWith('video/') ? 'video' : file?.mimetype?.startsWith('image/') ? 'image' : null);
  const details = Array.isArray(error?.details) ? error.details.slice(0, 25).map((item) => String(item)) : null;
  const record = {
    timestamp: new Date().toISOString(),
    attemptId,
    platform: platforms.length === 1 ? platforms[0] : 'pipeline',
    platforms,
    source,
    plannerId: null,
    mediaKind,
    fileName: file?.originalname || null,
    fileSize: file?.size || null,
    durationMs: null,
    message: generic.message || 'Falha no pipeline de publicacao.',
    code: resolvedCode,
    reason: generic.reason || null,
    apiStatus: generic.apiStatus || null,
    apiCode: generic.apiCode || null,
    httpStatus,
    stage: resolvedStage,
    requestId: generic.requestId || null,
    logId: generic.logId || null,
    publishId: generic.publishId || null,
    domain: generic.domain || null,
    location: generic.location || null,
    details,
  };
  console.error(`[social-publisher][publish:pipeline-error][${attemptId}] ${JSON.stringify(record)}`);
  appendPublishErrorLog(record);
  return {
    attemptId,
    message: record.message,
    code: record.code,
    httpStatus: record.httpStatus,
    stage: record.stage,
    requestId: record.requestId,
    logId: record.logId,
    reason: record.reason,
    apiStatus: record.apiStatus,
    apiCode: record.apiCode,
    details,
    platforms,
  };
}

function safeDelete(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File cleanup is best-effort.
  }
}

function mediaKindFromRequest(req) {
  const explicit = String(req.body.mediaKind || '').trim();
  if (['text', 'image', 'video'].includes(explicit)) return explicit;
  if (req.file?.mimetype?.startsWith('video/')) return 'video';
  if (req.file?.mimetype?.startsWith('image/')) return 'image';
  return 'text';
}

function validatePublishInput({ title, caption, mediaKind, platforms, file, requestedMediaUrl, networkContent = {}, youtubePrivacy, tiktokPrivacy, simulate = false }) {
  const errors = [];
  const perPlatform = {};
  const allowedPlatforms = Object.keys(platformRules);
  const unknown = platforms.filter((platform) => !allowedPlatforms.includes(platform));

  if (!platforms.length) errors.push('Selecione pelo menos uma rede');
  if (unknown.length) errors.push(`Rede desconhecida: ${unknown.join(', ')}`);
  if (!title && !caption) errors.push('Adicione um titulo ou uma legenda');
  if (!['text', 'image', 'video'].includes(mediaKind)) errors.push('Tipo de midia invalido');
  if (!['private', 'unlisted', 'public'].includes(youtubePrivacy)) errors.push('Privacidade do YouTube invalida');
  if (tiktokPrivacy && !['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(tiktokPrivacy)) errors.push('Privacidade do TikTok invalida');

  if (file && mediaKind === 'video' && !file.mimetype.startsWith('video/')) {
    errors.push('O tipo selecionado e Video, mas o arquivo enviado nao e um video');
  }
  if (file && mediaKind === 'image' && !file.mimetype.startsWith('image/')) {
    errors.push('O tipo selecionado e Imagem, mas o arquivo enviado nao e uma imagem');
  }
  if (mediaKind !== 'text' && !file && !requestedMediaUrl) {
    errors.push('Adicione um arquivo ou uma URL de midia');
  }
  if (requestedMediaUrl && !parseHttpUrl(requestedMediaUrl)) {
    errors.push('A URL da midia precisa usar http:// ou https://');
  }

  for (const platform of platforms.filter((item) => allowedPlatforms.includes(item))) {
    const rules = platformRules[platform];
    const platformErrors = [];
    const effective = platformContent({ title, caption, networkContent }, platform);
    const platformTitle = effective.title;
    const platformCaption = effective.caption;
    if (!platformTitle && !platformCaption) platformErrors.push(`${rules.label} precisa de algum texto para esta versão`);
    if (!rules.mediaKinds.includes(mediaKind)) {
      platformErrors.push(`${rules.label} nao aceita ${mediaKind} neste MVP`);
    }
    if (platform === 'youtube') {
      if (!simulate && !file) platformErrors.push('YouTube precisa do arquivo de video local');
      if (platformTitle.length > rules.titleMax) platformErrors.push(`Titulo do YouTube passa de ${rules.titleMax} caracteres`);
      if (Buffer.byteLength(platformCaption, 'utf8') > rules.descriptionMaxBytes) {
        platformErrors.push(`Descricao do YouTube passa de ${rules.descriptionMaxBytes} bytes`);
      }
    }
    if (platform === 'instagram') {
      if (platformCaption.length > rules.captionMax) platformErrors.push(`Legenda do Instagram passa de ${rules.captionMax} caracteres`);
      if (mediaKind === 'image' && file && !rules.imageMimeTypes.includes(file.mimetype)) {
        platformErrors.push('Imagem do Instagram deve ser JPEG');
      }
      if (mediaKind === 'video' && file) {
        if (!rules.videoMimeTypes.includes(file.mimetype)) {
          platformErrors.push('Reels do Instagram devem usar MP4 ou MOV neste MVP');
        }
        if (file.size > rules.videoMaxBytes) {
          platformErrors.push('Reel do Instagram passa de 300 MB');
        }
      }
      if (!simulate) {
        const instagramMediaUrl = requestedMediaUrl || publicUrlForFile(file);
        if (!instagramMediaUrl) platformErrors.push('Instagram precisa de uma URL publica da midia');
        else if (!isPublicHttpUrl(instagramMediaUrl)) {
          platformErrors.push('Instagram precisa acessar a midia por uma URL publica; localhost/rede privada nao funciona');
        }
      }
    }
    if (platform === 'linkedin') {
      if (platformCaption.length > rules.commentaryMax) platformErrors.push(`Texto do LinkedIn passa de ${rules.commentaryMax} caracteres`);
      if (!simulate && mediaKind !== 'text' && !file) platformErrors.push('LinkedIn precisa do arquivo local para imagem/video neste MVP');
      if (mediaKind === 'image' && file && !rules.imageMimeTypes.includes(file.mimetype)) {
        platformErrors.push('Imagem do LinkedIn deve ser JPG, PNG ou GIF');
      }
      if (mediaKind === 'video' && file) {
        if (!rules.videoMimeTypes.includes(file.mimetype)) platformErrors.push('Video do LinkedIn deve ser MP4');
        if (file.size < rules.videoMinBytes) platformErrors.push('Video do LinkedIn precisa ter pelo menos 75 KB');
        if (file.size > rules.videoMaxBytes) platformErrors.push('Video do LinkedIn passa de 500 MB');
      }
    }
    if (platform === 'tiktok') {
      if (mediaKind === 'video' && file) {
        if (!rules.videoMimeTypes.includes(file.mimetype)) platformErrors.push('TikTok aceita MP4, MOV ou WebM neste MVP');
        if (file.size > rules.videoMaxBytes) platformErrors.push('Video do TikTok passa de 4 GB');
        if (platformCaption.length > rules.captionMax) platformErrors.push(`Legenda do TikTok passa de ${rules.captionMax} caracteres`);
      }
      if (mediaKind === 'image') {
        if (file && !rules.imageMimeTypes.includes(file.mimetype)) platformErrors.push('Foto do TikTok deve ser JPEG ou WebP');
        if (file && file.size > rules.imageMaxBytes) platformErrors.push('Foto do TikTok passa de 20 MB');
        if (platformCaption.length > rules.photoDescriptionMax) platformErrors.push(`Descricao do TikTok passa de ${rules.photoDescriptionMax} caracteres`);
        if (!simulate) {
          const photoUrl = requestedMediaUrl || publicUrlForFile(file);
          if (!photoUrl || !isPublicHttpUrl(photoUrl)) platformErrors.push('Foto no TikTok exige URL HTTPS publica');
          const verifiedBase = getRuntimeConfig().tiktok.verifiedMediaBaseUrl;
          if (!verifiedBase) platformErrors.push('Configure no site a URL/prefixo de midia verificado no TikTok');
          else if (photoUrl && !photoUrl.startsWith(`${verifiedBase}/`) && photoUrl !== verifiedBase) platformErrors.push('A foto do TikTok nao esta sob o prefixo de URL verificado configurado');
        }
      }
      if (!simulate && mediaKind === 'video' && !file) platformErrors.push('TikTok precisa do arquivo de video local neste MVP');
    }
    if (platform === 'facebook') {
      if (!simulate && mediaKind === 'image') {
        const imageUrl = requestedMediaUrl || publicUrlForFile(file);
        if (!imageUrl || !isPublicHttpUrl(imageUrl)) platformErrors.push('Facebook precisa de URL publica para a imagem neste MVP');
      }
      if (!simulate && mediaKind === 'video' && !file) platformErrors.push('Facebook precisa do arquivo local para publicar Reel');
    }
    if (platform === 'googleBusiness') {
      if (!simulate && mediaKind === 'image') {
        const imageUrl = requestedMediaUrl || publicUrlForFile(file);
        if (!imageUrl || !isPublicHttpUrl(imageUrl)) platformErrors.push('Google Meu Negocio precisa de URL publica para a foto');
      }
    }
    perPlatform[platform] = platformErrors;
  }

  return {
    ok: errors.length === 0 && Object.values(perPlatform).every((items) => items.length === 0),
    errors,
    perPlatform,
  };
}

app.get(`${basePath}/api/health`, (_req, res) => {
  const runtime = getRuntimeConfig();
  res.json({ ok: true, now: new Date().toISOString(), demoMode: runtime.demoMode });
});

app.get(`${basePath}/api/config`, (req, res) => {
  const runtime = getRuntimeConfig();
  const isAdmin = req.socialUser?.role === 'social_publisher_admin';
  res.json({
    user: {
      id: req.socialUser?.id || null,
      name: req.socialUser?.name || '',
      email: req.socialUser?.sub || '',
      role: req.socialUser?.role || 'social_publisher',
      roleLabel: isAdmin ? 'Administrador' : 'Operador',
    },
    permissions: {
      canPublish: true,
      canManageConnections: true,
      canAdmin: isAdmin,
    },
    demoMode: runtime.demoMode,
    appBaseUrl: runtime.appBaseUrl,
    publicBaseUrl: runtime.publicBaseUrl,
    publicBaseIsPublic: isPublicHttpUrl(runtime.publicBaseUrl),
    maxUploadMb: runtime.maxUploadMb,
    docsVerifiedAt,
    apiVersions: {
      instagramGraph: runtime.instagram.graphVersion,
      metaGraph: runtime.instagram.graphVersion,
      facebookGraph: runtime.facebook.graphVersion,
      linkedin: runtime.linkedin.version,
      tiktok: 'v2',
      googleBusiness: 'v4 Local Posts',
    },
    platformRules,
    connections: connectionSummary(),
  });
});

function writableDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function diagnosticsPayload() {
  const runtime = getRuntimeConfig();
  const connections = connectionSummary();
  const appUrl = parseHttpUrl(runtime.appBaseUrl);
  const publicUrl = parseHttpUrl(runtime.publicBaseUrl);
  const publicMediaReady = Boolean(publicUrl && !privateHostname(publicUrl.hostname) && publicUrl.protocol === 'https:');
  const appPublicReady = Boolean(appUrl && !privateHostname(appUrl.hostname) && appUrl.protocol === 'https:');
  const uploadsWritable = writableDirectory(uploadsDir);

  const system = [
    { id: 'gateway', label: 'Gateway Social Publisher', status: 'ok', detail: `Processo ativo em ${basePath}.` },
    { id: 'mode', label: 'Modo de publicação', status: runtime.demoMode ? 'warning' : 'ok', detail: runtime.demoMode ? 'Modo Demo ativo: as publicações externas são simuladas.' : 'Modo Real ativo: publicações podem ser enviadas às redes.' },
    { id: 'app_url', label: 'URL pública do aplicativo', status: appPublicReady ? 'ok' : 'warning', detail: appPublicReady ? runtime.appBaseUrl : `Revise a URL do aplicativo (${runtime.appBaseUrl || 'não configurada'}). Em produção, prefira HTTPS público.` },
    { id: 'media_url', label: 'Entrega pública de mídia', status: publicMediaReady ? 'ok' : 'warning', detail: publicMediaReady ? runtime.publicBaseUrl : `A URL de mídia (${runtime.publicBaseUrl || 'não configurada'}) ainda não está pronta como HTTPS público.` },
    { id: 'uploads', label: 'Diretório de uploads', status: uploadsWritable ? 'ok' : 'error', detail: uploadsWritable ? 'Diretório disponível para gravação de mídia temporária.' : 'O processo não conseguiu gravar no diretório de uploads.' },
  ];

  const platformOrder = ['youtube', 'instagram', 'linkedin', 'tiktok', 'facebook', 'googleBusiness'];
  const platforms = platformOrder.map((key) => {
    const item = connections[key] || {};
    let status = 'ok';
    let detail = item.name ? `Conectado como ${item.name}.` : 'Conta conectada.';
    if (!item.configured) {
      status = 'warning';
      detail = 'Credenciais da API ainda não configuradas.';
    } else if (item.expired || item.needsReconnect) {
      status = 'warning';
      detail = 'A autorização da conta expirou ou precisa ser refeita.';
    } else if (!item.connected) {
      status = 'warning';
      detail = 'API configurada; falta conectar uma conta para publicar.';
    } else if (key === 'tiktok' && !runtime.tiktok.verifiedMediaBaseUrl) {
      status = 'warning';
      detail = 'Conta conectada; vídeos estão disponíveis, mas fotos ainda exigem um prefixo de mídia verificado.';
    }
    return {
      key,
      label: platformRules[key]?.label || key,
      configured: Boolean(item.configured),
      connected: Boolean(item.connected),
      expired: Boolean(item.expired),
      needsReconnect: Boolean(item.needsReconnect),
      status,
      detail,
    };
  });

  const callbacks = [
    { key: 'youtube', label: 'YouTube', url: runtime.youtube.redirectUri },
    { key: 'instagram', label: 'Instagram', url: runtime.instagram.redirectUri },
    { key: 'linkedin', label: 'LinkedIn', url: runtime.linkedin.redirectUri },
    { key: 'tiktok', label: 'TikTok', url: runtime.tiktok.redirectUri },
    { key: 'facebook', label: 'Facebook', url: runtime.facebook.redirectUri },
    { key: 'googleBusiness', label: 'Google Meu Negócio', url: runtime.googleBusiness.redirectUri },
  ];

  const platformsConfigured = platforms.filter((item) => item.configured).length;
  const platformsConnected = platforms.filter((item) => item.connected).length;
  const attention = system.filter((item) => item.status !== 'ok').length + platforms.filter((item) => item.status !== 'ok').length;
  const hasError = system.some((item) => item.status === 'error') || platforms.some((item) => item.status === 'error');

  return {
    ok: !hasError,
    status: hasError ? 'error' : attention ? 'warning' : 'ok',
    generatedAt: new Date().toISOString(),
    summary: { platformsConfigured, platformsConnected, attention },
    system,
    platforms,
    callbacks,
    versions: {
      instagramGraph: runtime.instagram.graphVersion,
      facebookGraph: runtime.facebook.graphVersion,
      linkedin: runtime.linkedin.version,
      tiktok: 'v2',
      googleBusiness: 'v4 Local Posts',
    },
    docsVerifiedAt,
  };
}

function requireSocialAdmin(req, res, next) {
  if (req.socialUser?.role === 'social_publisher_admin') return next();
  return res.status(403).json({
    error: 'Esta area e exclusiva para administradores do Social Publisher.',
    code: 'SOCIAL_ADMIN_REQUIRED',
  });
}

app.get(`${basePath}/api/diagnostics`, requireSocialAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(diagnosticsPayload());
});

app.get(`${basePath}/api/settings`, requireSocialAdmin, (_req, res) => {
  res.json(getSafeSettings());
});

app.post(`${basePath}/api/settings`, requireSocialAdmin, (req, res) => {
  try {
    const before = getRuntimeConfig();
    const settings = updateSettings(req.body || {});
    const after = getRuntimeConfig();

    const youtubeCleared = req.body?.youtube?.clearClientSecret === true;
    const instagramCleared = req.body?.instagram?.clearAppSecret === true;
    const linkedinCleared = req.body?.linkedin?.clearClientSecret === true;
    const tiktokCleared = req.body?.tiktok?.clearClientSecret === true;
    const facebookCleared = req.body?.facebook?.clearAppSecret === true;
    const googleBusinessCleared = req.body?.googleBusiness?.clearClientSecret === true;

    const googleCredentialsChanged = before.youtube.clientId !== after.youtube.clientId || before.youtube.clientSecret !== after.youtube.clientSecret;
    if (youtubeCleared || googleCredentialsChanged) clearPlatformToken('youtube');
    if (instagramCleared || before.instagram.appId !== after.instagram.appId || before.instagram.appSecret !== after.instagram.appSecret) clearPlatformToken('instagram');
    if (linkedinCleared || before.linkedin.clientId !== after.linkedin.clientId || before.linkedin.clientSecret !== after.linkedin.clientSecret) clearPlatformToken('linkedin');
    if (tiktokCleared || before.tiktok.clientKey !== after.tiktok.clientKey || before.tiktok.clientSecret !== after.tiktok.clientSecret) clearPlatformToken('tiktok');
    if (facebookCleared || before.facebook.appId !== after.facebook.appId || before.facebook.appSecret !== after.facebook.appSecret) clearPlatformToken('facebook');
    if (googleBusinessCleared
      || before.googleBusiness.clientId !== after.googleBusiness.clientId
      || before.googleBusiness.clientSecret !== after.googleBusiness.clientSecret
      || (after.googleBusiness.useYoutubeCredentials && googleCredentialsChanged)) clearPlatformToken('googleBusiness');

    res.json({ ok: true, settings, connections: connectionSummary() });
  } catch (error) {
    res.status(400).json({ error: formatError(error) });
  }
});

app.get(`${basePath}/api/history`, (req, res) => {
  res.json(getHistory(req.query.limit));
});

function publicTemplate(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    description: item.description || '',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdBy: item.createdBy || null,
    payload: item.payload || {},
  };
}

function normalizeTemplatePayload(body = {}) {
  const source = body.payload && typeof body.payload === 'object' ? body.payload : body;
  const payload = normalizePublicationPayload({
    ...source,
    networkContent: source.networkContent || {},
    mediaUrl: '',
    requestedMediaUrl: '',
  }, null);
  payload.requestedMediaUrl = null;
  return payload;
}

app.get(`${basePath}/api/templates`, (_req, res) => {
  res.json(getTemplates(500).map(publicTemplate));
});

app.post(`${basePath}/api/templates`, (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim().slice(0, 500);
    if (!name) return res.status(400).json({ error: 'Dê um nome ao template.' });
    if (name.length > 100) return res.status(400).json({ error: 'O nome do template pode ter no máximo 100 caracteres.' });
    const payload = normalizeTemplatePayload(req.body || {});
    if (!payload.title && !payload.caption) return res.status(400).json({ error: 'O template precisa ter um título ou texto base.' });
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      name,
      description,
      createdAt: now,
      updatedAt: now,
      payload,
      createdBy: { id: req.socialUser?.id || null, name: req.socialUser?.name || '', email: req.socialUser?.sub || '' },
    };
    return res.status(201).json(publicTemplate(saveTemplate(item)));
  } catch (error) {
    return res.status(400).json({ error: formatError(error) });
  }
});

app.put(`${basePath}/api/templates/:id`, (req, res) => {
  try {
    const current = getTemplate(req.params.id);
    if (!current) return res.status(404).json({ error: 'Template não encontrado.' });
    const name = String(req.body?.name ?? current.name).trim();
    if (!name) return res.status(400).json({ error: 'Dê um nome ao template.' });
    const payload = req.body?.payload ? normalizeTemplatePayload(req.body) : current.payload;
    const item = { ...current, name: name.slice(0, 100), description: String(req.body?.description ?? current.description ?? '').trim().slice(0, 500), payload, updatedAt: new Date().toISOString() };
    return res.json(publicTemplate(saveTemplate(item)));
  } catch (error) {
    return res.status(400).json({ error: formatError(error) });
  }
});

app.delete(`${basePath}/api/templates/:id`, (req, res) => {
  const removed = deleteTemplate(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Template não encontrado.' });
  return res.json({ ok: true });
});

app.delete(`${basePath}/api/connections/:platform`, (req, res) => {
  if (!Object.hasOwn(platformRules, req.params.platform)) {
    return res.status(404).json({ error: 'Rede desconhecida' });
  }
  clearPlatformToken(req.params.platform);
  return res.json({ ok: true });
});

app.patch(`${basePath}/api/connections/:platform/target`, express.json({ limit: '8kb' }), (req, res) => {
  try {
    const platform = req.params.platform;
    const value = String(req.body?.value || '').trim();
    if (!value) return res.status(400).json({ error: 'Selecione um destino válido.' });
    const summary = connectionSummary();

    if (platform === 'facebook') {
      const allowed = (summary.facebook?.pages || []).some((page) => page.id === value);
      if (!allowed) return res.status(400).json({ error: 'A Página selecionada não pertence à conta conectada.' });
      updateSettings({ facebook: { pageId: value } });
    } else if (platform === 'googleBusiness') {
      const allowed = (summary.googleBusiness?.locations || []).some((location) => location.name === value);
      if (!allowed) return res.status(400).json({ error: 'A unidade selecionada não pertence à conta conectada.' });
      updateSettings({ googleBusiness: { locationName: value } });
    } else {
      return res.status(400).json({ error: 'Esta rede não possui destino selecionável.' });
    }

    return res.json({ ok: true, connections: connectionSummary() });
  } catch (error) {
    return res.status(400).json({ error: formatError(error) });
  }
});

function oauthStart(platform, getUrl) {
  return (_req, res) => {
    try {
      res.redirect(getUrl(newState(platform)));
    } catch (error) {
      res.redirect(`${getRuntimeConfig().appBaseUrl}/?error=${encodeURIComponent(formatError(error))}`);
    }
  };
}

function oauthCallback(platform, handler) {
  return async (req, res) => {
    try {
      validateState(req.query.state, platform);
      if (!req.query.code) throw new Error('OAuth nao retornou o codigo de autorizacao');
      await handler(req.query.code);
      res.redirect(`${getRuntimeConfig().appBaseUrl}/?connected=${platform}`);
    } catch (error) {
      res.redirect(`${getRuntimeConfig().appBaseUrl}/?error=${encodeURIComponent(formatError(error))}`);
    }
  };
}

app.get(`${basePath}/auth/youtube`, oauthStart('youtube', getYouTubeAuthUrl));
app.get(`${basePath}/auth/youtube/callback`, oauthCallback('youtube', handleYouTubeCallback));
app.get(`${basePath}/auth/instagram`, oauthStart('instagram', getInstagramAuthUrl));
app.get(`${basePath}/auth/instagram/callback`, oauthCallback('instagram', handleInstagramCallback));
app.get(`${basePath}/auth/linkedin`, oauthStart('linkedin', getLinkedInAuthUrl));
app.get(`${basePath}/auth/linkedin/callback`, oauthCallback('linkedin', handleLinkedInCallback));
app.get(`${basePath}/auth/tiktok`, oauthStart('tiktok', getTikTokAuthUrl));
app.get(`${basePath}/auth/tiktok/callback`, oauthCallback('tiktok', handleTikTokCallback));
app.get(`${basePath}/auth/facebook`, oauthStart('facebook', getFacebookAuthUrl));
app.get(`${basePath}/auth/facebook/callback`, oauthCallback('facebook', handleFacebookCallback));
app.get(`${basePath}/auth/google-business`, oauthStart('googleBusiness', getGoogleBusinessAuthUrl));
app.get(`${basePath}/auth/google-business/callback`, oauthCallback('googleBusiness', handleGoogleBusinessCallback));

app.get(`${basePath}/api/tiktok/creator-info`, async (_req, res) => {
  try {
    res.json(await getTikTokCreatorInfo());
  } catch (error) {
    res.status(400).json({ error: formatError(error) });
  }
});

function boolValue(value) {
  return value === true || ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function normalizeNetworkContent(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const normalized = {};
  for (const platform of Object.keys(platformRules)) {
    const item = parsed[platform];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const customized = item.customized === true || boolValue(item.customized);
    if (!customized) continue;
    normalized[platform] = {
      customized: true,
      title: String(item.title || '').trim().slice(0, 10_000),
      caption: String(item.caption || '').trim().slice(0, 20_000),
      generated: item.generated === true || boolValue(item.generated),
    };
  }
  return normalized;
}

function platformContent(payload, platform) {
  const variant = payload?.networkContent?.[platform];
  if (!variant?.customized) return { title: payload.title || '', caption: payload.caption || '' };
  return {
    title: Object.hasOwn(variant, 'title') ? String(variant.title || '') : String(payload.title || ''),
    caption: Object.hasOwn(variant, 'caption') ? String(variant.caption || '') : String(payload.caption || ''),
  };
}

function normalizePublicationPayload(body = {}, file = null) {
  const explicitKind = String(body.mediaKind || '').trim();
  const inferredKind = file?.mimetype?.startsWith('video/') ? 'video' : file?.mimetype?.startsWith('image/') ? 'image' : 'text';
  const mediaKind = ['text', 'image', 'video'].includes(explicitKind) ? explicitKind : inferredKind;
  return {
    title: String(body.title || '').trim(),
    caption: String(body.caption || '').trim(),
    mediaKind,
    platforms: [...new Set(String(body.platforms || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean))],
    requestedMediaUrl: String(body.mediaUrl || body.requestedMediaUrl || '').trim() || null,
    networkContent: normalizeNetworkContent(body.networkContent),
    youtubePrivacy: String(body.youtubePrivacy || 'private'),
    tiktokPrivacy: String(body.tiktokPrivacy || ''),
    tiktokCommercial: boolValue(body.tiktokCommercial),
    tiktokBrandOrganic: boolValue(body.tiktokBrandOrganic),
    tiktokBrandContent: boolValue(body.tiktokBrandContent),
    tiktokAigc: boolValue(body.tiktokAigc),
    tiktokAllowComment: boolValue(body.tiktokAllowComment),
    tiktokAllowDuet: boolValue(body.tiktokAllowDuet),
    tiktokAllowStitch: boolValue(body.tiktokAllowStitch),
    tiktokConsent: boolValue(body.tiktokConsent),
  };
}

function publicationPreflight(payload, file, simulate) {
  const preflight = validatePublishInput({
    title: payload.title,
    caption: payload.caption,
    mediaKind: payload.mediaKind,
    platforms: payload.platforms,
    file,
    requestedMediaUrl: payload.requestedMediaUrl,
    networkContent: payload.networkContent,
    youtubePrivacy: payload.youtubePrivacy,
    tiktokPrivacy: payload.tiktokPrivacy,
    simulate,
  });

  if (payload.platforms.includes('tiktok') && !simulate && !payload.tiktokPrivacy) {
    preflight.ok = false;
    preflight.perPlatform.tiktok = [...(preflight.perPlatform.tiktok || []), 'No TikTok, selecione manualmente a privacidade antes de publicar'];
  }
  if (payload.platforms.includes('tiktok') && !simulate && !payload.tiktokConsent) {
    preflight.ok = false;
    preflight.perPlatform.tiktok = [...(preflight.perPlatform.tiktok || []), 'Confirme o consentimento de publicação no TikTok'];
  }
  if (payload.platforms.includes('tiktok') && payload.tiktokCommercial && !payload.tiktokBrandOrganic && !payload.tiktokBrandContent) {
    preflight.ok = false;
    preflight.perPlatform.tiktok = [...(preflight.perPlatform.tiktok || []), 'No TikTok, marque Minha marca e/ou Parceria paga quando Conteudo promocional estiver ativado'];
  }
  return preflight;
}

function publicationNeedsRetainedUpload(payload, file) {
  if (!file || payload.requestedMediaUrl) return false;
  return payload.platforms.includes('instagram')
    || payload.platforms.includes('facebook')
    || payload.platforms.includes('googleBusiness')
    || (payload.platforms.includes('tiktok') && payload.mediaKind === 'image');
}

async function executePublication({ payload, file = null, source = 'manual', plannerId = null, createdBy = null }) {
  const startedAt = Date.now();
  const runtime = getRuntimeConfig();
  const filePath = file?.path || null;
  const publicMediaUrl = payload.requestedMediaUrl || publicUrlForFile(file);
  const preflight = publicationPreflight(payload, file, runtime.demoMode);

  if (!preflight.ok) {
    const details = [...preflight.errors, ...Object.values(preflight.perPlatform).flat()];
    const error = new Error('Revise a publicacao antes de enviar');
    error.statusCode = 400;
    error.details = details;
    error.preflight = preflight;
    throw error;
  }

  const results = {};
  const createdAt = new Date().toISOString();

  if (runtime.demoMode) {
    for (const platform of payload.platforms) {
      results[platform] = {
        status: 'success',
        demo: true,
        id: `demo_${platform}_${crypto.randomBytes(6).toString('hex')}`,
        message: 'Publicacao simulada com sucesso',
        durationMs: 0,
      };
    }
  } else {
    for (const platform of payload.platforms) {
      const platformStarted = Date.now();
      const content = platformContent(payload, platform);
      try {
        if (platform === 'youtube') {
          results.youtube = {
            status: 'success',
            ...(await publishYouTube({
              filePath,
              mimeType: file?.mimetype,
              title: content.title || content.caption.slice(0, 100) || 'Video',
              description: content.caption,
              privacyStatus: payload.youtubePrivacy,
            })),
          };
        } else if (platform === 'instagram') {
          results.instagram = {
            status: 'success',
            ...(await publishInstagram({
              mediaUrl: publicMediaUrl,
              mediaKind: payload.mediaKind,
              caption: content.caption || content.title,
            })),
          };
        } else if (platform === 'linkedin') {
          results.linkedin = {
            status: 'success',
            ...(await publishLinkedIn({
              filePath,
              mediaKind: payload.mediaKind,
              caption: content.caption || content.title,
              title: content.title,
            })),
          };
        } else if (platform === 'tiktok') {
          results.tiktok = {
            status: 'success',
            ...(await publishTikTok({
              filePath,
              mediaUrl: publicMediaUrl,
              mediaKind: payload.mediaKind,
              caption: content.caption || content.title,
              privacyLevel: payload.tiktokPrivacy,
              mimeType: file?.mimetype,
              brandOrganic: payload.tiktokCommercial && payload.tiktokBrandOrganic,
              brandContent: payload.tiktokCommercial && payload.tiktokBrandContent,
              isAigc: payload.tiktokAigc,
              allowComment: payload.tiktokAllowComment,
              allowDuet: payload.tiktokAllowDuet,
              allowStitch: payload.tiktokAllowStitch,
            })),
          };
        } else if (platform === 'facebook') {
          results.facebook = {
            status: 'success',
            ...(await publishFacebook({
              filePath,
              mediaUrl: publicMediaUrl,
              mediaKind: payload.mediaKind,
              caption: content.caption || content.title,
              title: content.title,
            })),
          };
        } else if (platform === 'googleBusiness') {
          results.googleBusiness = {
            status: 'success',
            ...(await publishGoogleBusiness({
              mediaUrl: publicMediaUrl,
              mediaKind: payload.mediaKind,
              caption: content.caption || content.title,
              title: content.title,
            })),
          };
        }
      } catch (error) {
        const durationMs = Date.now() - platformStarted;
        const attemptId = crypto.randomUUID();
        results[platform] = logPlatformPublishError({
          platform,
          error,
          attemptId,
          source,
          plannerId,
          payload,
          file,
          durationMs,
        });
      } finally {
        if (results[platform]) results[platform].durationMs = Date.now() - platformStarted;
      }
    }
  }

  const entry = {
    id: crypto.randomUUID(),
    createdAt,
    durationMs: Date.now() - startedAt,
    title: payload.title,
    caption: payload.caption,
    networkContent: payload.networkContent || {},
    mediaKind: payload.mediaKind,
    originalFileName: file?.originalname || null,
    fileSize: file?.size || null,
    mediaUrl: payload.requestedMediaUrl,
    platforms: payload.platforms,
    results,
    demoMode: runtime.demoMode,
    source,
    plannerId,
    createdBy,
  };
  addHistory(entry);
  return { entry, retainUploadedFile: publicationNeedsRetainedUpload(payload, file) };
}

function plannerFileForItem(item) {
  const media = item?.media;
  if (!media?.storedFileName) return null;
  const filePath = path.join(uploadsDir, path.basename(media.storedFileName));
  if (!fs.existsSync(filePath)) return null;
  let size = Number(media.size || 0);
  try { size = fs.statSync(filePath).size; } catch {}
  return {
    fieldname: 'media',
    originalname: media.originalName || media.storedFileName,
    encoding: '7bit',
    mimetype: media.mimetype || 'application/octet-stream',
    destination: uploadsDir,
    filename: path.basename(media.storedFileName),
    path: filePath,
    size,
  };
}

function publicPlannerItem(item) {
  if (!item) return null;
  const file = plannerFileForItem(item);
  return {
    ...item,
    media: item.media ? {
      originalName: item.media.originalName || null,
      mimetype: item.media.mimetype || null,
      size: item.media.size || null,
      available: Boolean(file),
      publicUrl: file ? publicUrlForFile(file) : null,
    } : null,
  };
}

function plannerModeFromRequest(req) {
  return String(req.body?.mode || '').toLowerCase() === 'scheduled' ? 'scheduled' : 'draft';
}

function validateScheduledAt(value) {
  const timestamp = new Date(String(value || '')).getTime();
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp < Date.now() + 15_000) return null;
  return new Date(timestamp).toISOString();
}

async function savePlannerFromRequest(req, res) {
  const uploadedPath = req.file?.path || null;
  let keepUploadedFile = false;
  try {
    const existing = req.params.id ? getPlannerItem(req.params.id) : null;
    if (req.params.id && !existing) return res.status(404).json({ error: 'Rascunho ou agendamento não encontrado.' });
    if (existing && ['processing', 'published'].includes(existing.status)) {
      return res.status(409).json({ error: existing.status === 'processing' ? 'Esta publicação está sendo processada agora.' : 'Uma publicação já concluída não pode ser editada. Use o conteúdo novamente para criar outra.' });
    }

    const removeExistingMedia = boolValue(req.body?.removeMedia) && !req.file;
    const existingFile = existing && !removeExistingMedia ? plannerFileForItem(existing) : null;
    const payload = normalizePublicationPayload(req.body, req.file || existingFile);
    const mode = plannerModeFromRequest(req);
    const useExistingMedia = !req.file && !removeExistingMedia && payload.mediaKind !== 'text' && existingFile;
    const effectiveFile = payload.mediaKind === 'text' ? null : (req.file || (useExistingMedia ? existingFile : null));

    if (mode === 'draft') {
      if (!payload.title && !payload.caption && !effectiveFile && !payload.requestedMediaUrl) {
        return res.status(400).json({ error: 'Adicione algum conteúdo antes de salvar o rascunho.' });
      }
    }

    let scheduledAt = null;
    if (mode === 'scheduled') {
      scheduledAt = validateScheduledAt(req.body?.scheduledAt);
      if (!scheduledAt) return res.status(400).json({ error: 'Escolha uma data e horário futuros para o agendamento.' });
      const preflight = publicationPreflight(payload, effectiveFile, getRuntimeConfig().demoMode);
      if (!preflight.ok) {
        return res.status(400).json({
          error: 'Revise a publicação antes de agendar.',
          details: [...preflight.errors, ...Object.values(preflight.perPlatform).flat()],
          preflight,
        });
      }
    }

    const now = new Date().toISOString();
    const nextMedia = payload.mediaKind === 'text' || removeExistingMedia ? null : req.file ? {
      storedFileName: req.file.filename,
      originalName: req.file.originalname || req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
    } : existing?.media || null;

    const item = {
      id: existing?.id || crypto.randomUUID(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: mode,
      scheduledAt,
      processingStartedAt: null,
      publishedAt: null,
      historyId: null,
      results: null,
      lastError: null,
      mediaRetainUntil: null,
      payload,
      media: nextMedia,
      createdBy: existing?.createdBy || {
        id: req.socialUser?.id || null,
        name: req.socialUser?.name || '',
        email: req.socialUser?.sub || '',
      },
    };

    const saved = savePlannerItem(item);
    if (!saved) return res.status(503).json({ error: 'O planejador está ocupado. Tente salvar novamente em alguns segundos.' });
    keepUploadedFile = Boolean(req.file && nextMedia?.storedFileName === req.file.filename);

    if (existing?.media?.storedFileName && existing.media.storedFileName !== nextMedia?.storedFileName) {
      safeDelete(path.join(uploadsDir, path.basename(existing.media.storedFileName)));
    }

    return res.status(existing ? 200 : 201).json(publicPlannerItem(saved));
  } catch (error) {
    return res.status(500).json({ error: formatError(error) });
  } finally {
    if (uploadedPath && !keepUploadedFile) safeDelete(uploadedPath);
  }
}

app.get(`${basePath}/api/planner`, (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 500, 1000));
  res.json(getPlannerItems(limit).map(publicPlannerItem));
});

app.post(`${basePath}/api/planner`, upload.single('media'), savePlannerFromRequest);
app.put(`${basePath}/api/planner/:id`, upload.single('media'), savePlannerFromRequest);

app.delete(`${basePath}/api/planner/:id`, (req, res) => {
  const item = getPlannerItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado.' });
  if (item.status === 'processing') return res.status(409).json({ error: 'Esta publicação está sendo processada agora.' });
  const removed = deletePlannerItem(item.id);
  if (!removed) return res.status(503).json({ error: 'Não foi possível remover agora. Tente novamente.' });
  if (removed.media?.storedFileName) safeDelete(path.join(uploadsDir, path.basename(removed.media.storedFileName)));
  return res.json({ ok: true });
});

app.post(`${basePath}/api/planner/:id/unschedule`, (req, res) => {
  const item = getPlannerItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (item.status !== 'scheduled') return res.status(409).json({ error: 'Somente itens agendados podem voltar para rascunho.' });
  const now = new Date().toISOString();
  item.status = 'draft';
  item.scheduledAt = null;
  item.updatedAt = now;
  item.lastError = null;
  const saved = savePlannerItem(item);
  return saved ? res.json(publicPlannerItem(saved)) : res.status(503).json({ error: 'Não foi possível alterar o agendamento agora.' });
});

function plannerExecutionStatus(entry) {
  const values = Object.values(entry?.results || {});
  const successes = values.filter((result) => result?.status === 'success').length;
  const errors = values.filter((result) => result?.status === 'error').length;
  if (values.length && errors === 0) return 'published';
  if (successes > 0 && errors > 0) return 'partial';
  return 'failed';
}

async function executePlannerItem(item) {
  const file = plannerFileForItem(item);
  const now = new Date().toISOString();
  try {
    const { entry, retainUploadedFile } = await executePublication({
      payload: item.payload || {},
      file,
      source: 'scheduled',
      plannerId: item.id,
      createdBy: item.createdBy || null,
    });
    const status = plannerExecutionStatus(entry);
    const updated = {
      ...item,
      status,
      updatedAt: new Date().toISOString(),
      processingStartedAt: null,
      publishedAt: new Date().toISOString(),
      historyId: entry.id,
      results: entry.results,
      lastError: status === 'published' ? null : status === 'partial' ? 'A publicação foi concluída em algumas redes e falhou em outras. Revise os resultados antes de tentar novamente.' : 'Nenhuma rede concluiu a publicação.',
    };

    if (file && status === 'published') {
      if (retainUploadedFile) {
        try { fs.utimesSync(file.path, new Date(), new Date()); } catch {}
        updated.mediaRetainUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      } else {
        safeDelete(file.path);
        updated.media = null;
        updated.mediaRetainUntil = null;
      }
    }
    // Em falha/parcial mantemos a mídia para revisão manual e evitamos repostar
    // automaticamente, pois redes já concluídas poderiam ser duplicadas.
    savePlannerItem(updated);
    return updated;
  } catch (error) {
    const updated = {
      ...item,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      processingStartedAt: null,
      publishedAt: null,
      lastError: formatError(error),
      failureDetails: Array.isArray(error?.details) ? error.details : null,
    };
    savePlannerItem(updated);
    return updated;
  }
}

app.post(`${basePath}/api/planner/:id/publish-now`, async (req, res) => {
  const claimed = claimPlannerItem(req.params.id, ['draft', 'scheduled']);
  if (!claimed) {
    const current = getPlannerItem(req.params.id);
    if (!current) return res.status(404).json({ error: 'Rascunho ou agendamento não encontrado.' });
    return res.status(409).json({ error: 'Este item não pode ser publicado agora no estado atual.' });
  }
  const result = await executePlannerItem(claimed);
  const response = publicPlannerItem(result);
  return res.status(result.status === 'published' ? 200 : 207).json(response);
});

app.post(`${basePath}/api/publish`, upload.single('media'), async (req, res) => {
  const filePath = req.file?.path || null;
  let retainUploadedFile = false;
  try {
    const payload = normalizePublicationPayload(req.body, req.file);
    const executed = await executePublication({
      payload,
      file: req.file || null,
      source: 'manual',
      createdBy: {
        id: req.socialUser?.id || null,
        name: req.socialUser?.name || '',
        email: req.socialUser?.sub || '',
      },
    });
    retainUploadedFile = executed.retainUploadedFile;
    return res.json(executed.entry);
  } catch (error) {
    const logged = logPublishPipelineError({
      error,
      req,
      file: req.file || null,
      stage: error?.preflight ? 'preflight' : 'publish_route',
      source: 'manual',
    });
    const status = Number(error?.statusCode) || Number(logged.httpStatus) || 500;
    const responsePayload = {
      error: formatError(error),
      code: logged.code,
      stage: logged.stage,
      attemptId: logged.attemptId,
    };
    if (logged.requestId) responsePayload.requestId = logged.requestId;
    if (logged.logId) responsePayload.logId = logged.logId;
    if (logged.reason) responsePayload.reason = logged.reason;
    if (logged.apiStatus) responsePayload.apiStatus = logged.apiStatus;
    if (logged.apiCode) responsePayload.apiCode = logged.apiCode;
    if (Array.isArray(error?.details)) responsePayload.details = error.details;
    if (error?.preflight) responsePayload.preflight = error.preflight;
    return res.status(status).json(responsePayload);
  } finally {
    if (!retainUploadedFile) safeDelete(filePath);
  }
});

let plannerRunnerActive = false;
async function runPlannerQueue() {
  if (plannerRunnerActive) return;
  plannerRunnerActive = true;
  try {
    const due = claimDuePlannerItems(new Date(), 2);
    for (const item of due) {
      try {
        await executePlannerItem(item);
      } catch (error) {
        console.error(`[planner] Falha inesperada no item ${item.id}:`, formatError(error));
      }
    }
  } finally {
    plannerRunnerActive = false;
  }
}

const plannerTimer = setInterval(() => {
  runPlannerQueue().catch((error) => console.error('[planner] Falha na fila:', formatError(error)));
}, 30_000);
plannerTimer.unref();
setTimeout(() => runPlannerQueue().catch((error) => console.error('[planner] Falha inicial:', formatError(error))), 2_000).unref();


app.use((error, req, res, _next) => {
  const isPublishRequest = String(req?.originalUrl || req?.url || '').includes(`${basePath}/api/publish`);
  const logged = isPublishRequest
    ? logPublishPipelineError({ error, req, file: req?.file || null, stage: 'upload_middleware', source: 'manual' })
    : null;
  const meta = logged ? { stage: logged.stage, attemptId: logged.attemptId } : {};
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `O arquivo ultrapassa o limite atual de ${maxUploadMb} MB do Social Publisher.`,
      code: 'UPLOAD_TOO_LARGE',
      maxUploadMb,
      ...meta,
    });
  }
  if (/apenas arquivo de imagem ou video/i.test(String(error?.message || ''))) {
    return res.status(415).json({
      error: 'Formato de arquivo não aceito. Envie uma imagem ou um vídeo.',
      code: 'UNSUPPORTED_MEDIA_TYPE',
      ...meta,
    });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'A solicitação enviada é grande demais.', code: 'REQUEST_TOO_LARGE', ...meta });
  }
  const message = formatError(error);
  return res.status(500).json({
    error: message || 'Erro interno inesperado.',
    code: logged?.code || 'INTERNAL_ERROR',
    requestId: logged?.requestId || undefined,
    ...meta,
  });
});

app.listen(port, () => {
  const runtime = getRuntimeConfig();
  console.log(`Social Publisher running at ${runtime.appBaseUrl}`);
  console.log(`Demo mode: ${runtime.demoMode ? 'ON' : 'OFF'}`);
  console.log(`Public media base: ${runtime.publicBaseUrl}`);
});
