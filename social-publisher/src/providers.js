import fs from 'node:fs';
import https from 'node:https';
import axios from 'axios';
import { getTokens, savePlatformToken } from './store.js';
import { getRuntimeConfig } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = 1024 * 1024;

function required(value, name) {
  if (!value) throw new Error(`Configuracao ausente: ${name}`);
  return value;
}

function graphVersion() {
  return getRuntimeConfig().instagram.graphVersion;
}

function linkedinVersion() {
  return getRuntimeConfig().linkedin.version;
}

function linkedinHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': linkedinVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  };
}

function youtubeRedirectUri() {
  return getRuntimeConfig().youtube.redirectUri;
}

function instagramRedirectUri() {
  return getRuntimeConfig().instagram.redirectUri;
}

function linkedinRedirectUri() {
  return getRuntimeConfig().linkedin.redirectUri;
}

function axiosApiError(error, fallback) {
  const data = error?.response?.data;
  const message = data?.error?.message || data?.message || data?.error_description || error?.message;
  const err = new Error(message || fallback);
  err.status = error?.response?.status;
  err.code = data?.error?.code || data?.code;
  return err;
}

function youtubeErrorMeta(source = {}) {
  const data = source?.response?.data || (source && typeof source === 'object' ? source : {});
  const apiError = data?.error && typeof data.error === 'object' ? data.error : {};
  const details = Array.isArray(apiError?.errors) ? apiError.errors : [];
  const first = details[0] || {};
  const headers = source?.response?.headers || {};
  const header = (name) => headers?.[name] || headers?.[name.toLowerCase()] || null;
  return {
    message: apiError?.message || first?.message || data?.message || data?.error_description || null,
    reason: first?.reason || null,
    apiStatus: apiError?.status || null,
    apiCode: Number.isFinite(Number(apiError?.code)) ? Number(apiError.code) : null,
    domain: first?.domain || null,
    location: first?.location || null,
    requestId: header('x-guploader-uploadid') || header('x-goog-request-id') || header('x-request-id') || null,
  };
}

function youtubeApiError(source, fallback, extra = {}) {
  const meta = youtubeErrorMeta(source);
  const err = new Error(meta.message || source?.message || fallback);
  err.status = source?.response?.status || source?.status || meta.apiCode || null;
  err.code = meta.reason || meta.apiStatus || source?.code || null;
  err.reason = meta.reason || null;
  err.apiStatus = meta.apiStatus || null;
  err.apiCode = meta.apiCode || null;
  err.domain = meta.domain || null;
  err.location = meta.location || null;
  err.requestId = meta.requestId || null;
  err.platform = 'youtube';
  Object.assign(err, extra);
  return err;
}

function youtubeLocalError(message, code, stage, extra = {}) {
  const err = new Error(message);
  err.platform = 'youtube';
  err.code = code || null;
  err.stage = stage || null;
  Object.assign(err, extra);
  return err;
}

function tiktokErrorMeta(data = {}) {
  const apiError = data?.error || {};
  return {
    code: apiError?.code || data?.code || null,
    message: apiError?.message || data?.message || data?.error_description || null,
    logId: apiError?.log_id || apiError?.logid || data?.log_id || data?.logid || null,
  };
}

function tiktokApiError(source, fallback, extra = {}) {
  const data = source?.response?.data || (source && typeof source === 'object' ? source : {});
  const meta = tiktokErrorMeta(data);
  const err = new Error(meta.message || source?.message || fallback);
  err.status = source?.response?.status || source?.status || null;
  err.code = meta.code || source?.code || null;
  err.logId = meta.logId || source?.logId || null;
  err.platform = 'tiktok';
  Object.assign(err, extra);
  return err;
}

function assertTikTokOk(data, fallback, extra = {}) {
  if (data?.error?.code && data.error.code !== 'ok') throw tiktokApiError(data, fallback, extra);
  return data?.data || {};
}

// ---------------------------------------------------------------------------
// YouTube / Google OAuth + resumable video upload
// ---------------------------------------------------------------------------

export function getYouTubeAuthUrl(state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', required(getRuntimeConfig().youtube.clientId, 'Google Client ID'));
  url.searchParams.set('redirect_uri', youtubeRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeYouTubeToken(params) {
  const body = new URLSearchParams({
    client_id: required(getRuntimeConfig().youtube.clientId, 'Google Client ID'),
    client_secret: required(getRuntimeConfig().youtube.clientSecret, 'Google Client Secret'),
    ...params,
  });
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30_000,
    });
    return response.data;
  } catch (error) {
    throw youtubeApiError(error, 'Falha ao obter token do YouTube', { stage: params?.grant_type === 'refresh_token' ? 'token_refresh' : 'token_exchange' });
  }
}

export async function handleYouTubeCallback(code) {
  const tokenData = await exchangeYouTubeToken({
    code,
    redirect_uri: youtubeRedirectUri(),
    grant_type: 'authorization_code',
  });

  const accessToken = tokenData.access_token;
  let channel;
  try {
    channel = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: 'true' },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30_000,
    });
  } catch (error) {
    throw youtubeApiError(error, 'Falha ao consultar o canal do YouTube', { stage: 'channel_lookup' });
  }
  const item = channel.data.items?.[0];
  const previous = getTokens().youtube || {};

  return savePlatformToken('youtube', {
    access_token: accessToken,
    refresh_token: tokenData.refresh_token || previous.refresh_token || null,
    token_type: tokenData.token_type,
    scope: tokenData.scope,
    expiry_at: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
    channelId: item?.id || null,
    channelName: item?.snippet?.title || 'YouTube',
    connectedAt: new Date().toISOString(),
  });
}

async function getYouTubeAccessToken() {
  const stored = getTokens().youtube;
  if (!stored) throw youtubeLocalError('YouTube nao esta conectado', 'youtube_not_connected', 'token_check');
  if (stored.access_token && (!stored.expiry_at || stored.expiry_at > Date.now() + 60_000)) {
    return stored.access_token;
  }
  if (!stored.refresh_token) {
    throw youtubeLocalError('Token do YouTube expirou e nao ha refresh token. Reconecte o YouTube.', 'youtube_refresh_token_missing', 'token_refresh');
  }

  const refreshed = await exchangeYouTubeToken({
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });
  savePlatformToken('youtube', {
    ...stored,
    access_token: refreshed.access_token,
    token_type: refreshed.token_type || stored.token_type,
    scope: refreshed.scope || stored.scope,
    expiry_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
  });
  return refreshed.access_token;
}

function parseUploadedRange(rangeHeader) {
  if (!rangeHeader) return -1;
  const match = String(rangeHeader).match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) : -1;
}

async function queryYouTubeUploadOffset(sessionUrl, accessToken, totalSize) {
  let response;
  try {
    response = await axios.put(sessionUrl, null, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': '0',
        'Content-Range': `bytes */${totalSize}`,
      },
      validateStatus: (status) => status === 308 || (status >= 200 && status < 300),
      maxRedirects: 0,
      timeout: 30_000,
    });
  } catch (error) {
    throw youtubeApiError(error, 'Falha ao consultar o estado do upload do YouTube', { stage: 'resumable_status' });
  }

  if (response.status >= 200 && response.status < 300 && response.status !== 308) {
    return { complete: true, data: response.data, nextOffset: totalSize };
  }
  return {
    complete: false,
    data: null,
    nextOffset: parseUploadedRange(response.headers.range) + 1,
  };
}

async function uploadYouTubeChunks({ sessionUrl, accessToken, filePath, fileSize, mimeType }) {
  const configuredMb = Number(getRuntimeConfig().youtube.chunkMb || 8);
  const requestedBytes = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * MB : 8 * MB;
  const quantum = 256 * 1024;
  const chunkSize = Math.max(quantum, Math.floor(requestedBytes / quantum) * quantum);
  let offset = 0;

  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize - 1, fileSize - 1);
    let completed = false;

    for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
      const stream = fs.createReadStream(filePath, { start: offset, end });
      try {
        const response = await axios.put(sessionUrl, stream, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': mimeType || 'application/octet-stream',
            'Content-Length': String(end - offset + 1),
            'Content-Range': `bytes ${offset}-${end}/${fileSize}`,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          validateStatus: (status) => status === 308 || (status >= 200 && status < 300),
          timeout: 180_000,
          maxRedirects: 0,
        });

        if (response.status === 308) {
          const serverLast = parseUploadedRange(response.headers.range);
          offset = serverLast >= offset ? serverLast + 1 : end + 1;
          completed = true;
        } else {
          return response.data;
        }
      } catch (error) {
        if (attempt >= 3) throw youtubeApiError(error, 'Falha durante upload resumivel do YouTube', { stage: 'resumable_upload', chunkStart: offset, chunkEnd: end });
        await sleep(750 * attempt);
        const status = await queryYouTubeUploadOffset(sessionUrl, accessToken, fileSize);
        if (status.complete) return status.data;
        offset = Math.max(offset, status.nextOffset);
        if (offset > end) completed = true;
      }
    }
  }

  const finalStatus = await queryYouTubeUploadOffset(sessionUrl, accessToken, fileSize);
  if (finalStatus.complete) return finalStatus.data;
  throw youtubeLocalError('YouTube nao confirmou a conclusao do upload resumivel', 'youtube_upload_not_confirmed', 'resumable_status');
}

export async function publishYouTube({ filePath, mimeType, title, description, privacyStatus = 'private' }) {
  if (!filePath) throw youtubeLocalError('YouTube exige um arquivo de video local', 'youtube_video_required', 'validation');
  const fileSize = fs.statSync(filePath).size;
  const accessToken = await getYouTubeAccessToken();
  const metadata = {
    snippet: {
      title: title || 'Video sem titulo',
      description: description || '',
    },
    status: { privacyStatus },
  };

  let initResponse;
  try {
    initResponse = await axios.post(
      'https://www.googleapis.com/upload/youtube/v3/videos',
      metadata,
      {
        params: { uploadType: 'resumable', part: 'snippet,status' },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(fileSize),
          'X-Upload-Content-Type': mimeType || 'video/*',
        },
        timeout: 30_000,
      },
    );
  } catch (error) {
    throw youtubeApiError(error, 'Falha ao iniciar o upload no YouTube', { stage: 'resumable_init' });
  }

  const sessionUrl = initResponse.headers.location;
  const requestId = initResponse.headers?.['x-guploader-uploadid'] || initResponse.headers?.['x-goog-request-id'] || null;
  if (!sessionUrl) throw youtubeLocalError('YouTube nao retornou a URL da sessao resumivel', 'youtube_session_url_missing', 'resumable_init', { requestId });

  try {
    const data = await uploadYouTubeChunks({
      sessionUrl,
      accessToken,
      filePath,
      fileSize,
      mimeType: mimeType || 'video/*',
    });

    return {
      id: data?.id || null,
      url: data?.id ? `https://www.youtube.com/watch?v=${data.id}` : null,
      requestId,
    };
  } catch (error) {
    if (!error.requestId && requestId) error.requestId = requestId;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Instagram API with Instagram Login (direct Business Login)
// ---------------------------------------------------------------------------

const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const INSTAGRAM_LONG_TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const INSTAGRAM_MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

export function getInstagramAuthUrl(state) {
  const appId = required(getRuntimeConfig().instagram.appId, 'Instagram App ID');
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', instagramRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  url.searchParams.set('state', state);
  // Keep the flow on Instagram instead of falling back to Facebook Login.
  url.searchParams.set('enable_fb_login', '0');
  url.searchParams.set('force_authentication', '1');
  return url.toString();
}

function normalizeInstagramTokenResponse(data) {
  if (Array.isArray(data?.data)) return data.data[0] || {};
  return data || {};
}

async function exchangeInstagramLongLivedToken(shortLivedToken) {
  try {
    const res = await axios.get('https://graph.instagram.com/access_token', {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: required(getRuntimeConfig().instagram.appSecret, 'Instagram App Secret'),
        access_token: shortLivedToken,
      },
      timeout: 30_000,
    });
    const token = res.data?.access_token;
    if (!token) throw new Error('Instagram nao retornou o token de longa duracao');
    return {
      accessToken: token,
      expiresIn: Number(res.data?.expires_in) || null,
      tokenType: res.data?.token_type || 'bearer',
    };
  } catch (error) {
    throw axiosApiError(error, 'Falha ao trocar o token do Instagram por um token de longa duracao');
  }
}

async function refreshInstagramLongLivedToken(stored) {
  try {
    const res = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: stored.accessToken,
      },
      timeout: 30_000,
    });
    const token = res.data?.access_token;
    if (!token) throw new Error('Instagram nao retornou um novo token');
    const expiresIn = Number(res.data?.expires_in) || null;
    const refreshedAt = Date.now();
    return savePlatformToken('instagram', {
      ...stored,
      accessToken: token,
      tokenType: res.data?.token_type || stored.tokenType || 'bearer',
      expiresAt: expiresIn ? refreshedAt + (expiresIn * 1000) : stored.expiresAt || null,
      tokenRefreshedAt: new Date(refreshedAt).toISOString(),
    });
  } catch (error) {
    throw axiosApiError(error, 'Nao foi possivel renovar o token do Instagram; reconecte a conta');
  }
}

async function getValidInstagramConnection() {
  let stored = getTokens().instagram;
  if (!stored?.accessToken || !stored?.igUserId || stored.authMode !== 'instagram_login') {
    throw new Error('Instagram precisa ser reconectado usando o Login direto do Instagram');
  }

  const now = Date.now();
  if (stored.expiresAt && stored.expiresAt <= now + 60_000) {
    throw new Error('A conexao do Instagram expirou. Reconecte a conta.');
  }

  const connectedAt = Date.parse(stored.tokenRefreshedAt || stored.connectedAt || '');
  const oldEnoughToRefresh = Number.isFinite(connectedAt) && now - connectedAt >= INSTAGRAM_MIN_REFRESH_AGE_MS;
  const nearExpiry = Boolean(stored.expiresAt && stored.expiresAt - now <= INSTAGRAM_LONG_TOKEN_REFRESH_WINDOW_MS);
  if (nearExpiry && oldEnoughToRefresh) stored = await refreshInstagramLongLivedToken(stored);

  return stored;
}

export async function handleInstagramCallback(code) {
  let shortToken;
  try {
    const body = new URLSearchParams({
      client_id: required(getRuntimeConfig().instagram.appId, 'Instagram App ID'),
      client_secret: required(getRuntimeConfig().instagram.appSecret, 'Instagram App Secret'),
      grant_type: 'authorization_code',
      redirect_uri: instagramRedirectUri(),
      code: String(code),
    });
    const tokenRes = await axios.post('https://api.instagram.com/oauth/access_token', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30_000,
    });
    shortToken = normalizeInstagramTokenResponse(tokenRes.data);
  } catch (error) {
    throw axiosApiError(error, 'Falha ao trocar o codigo OAuth do Instagram');
  }

  if (!shortToken?.access_token) throw new Error('Instagram nao retornou um access token');
  const longToken = await exchangeInstagramLongLivedToken(shortToken.access_token);

  let profile = null;
  try {
    const profileRes = await axios.get(`https://graph.instagram.com/${graphVersion()}/me`, {
      params: {
        fields: 'user_id,username',
        access_token: longToken.accessToken,
      },
      timeout: 30_000,
    });
    profile = profileRes.data || null;
  } catch {
    // The OAuth response already contains the Instagram-scoped user ID. Profile
    // lookup is only needed to show a friendly @username in the dashboard.
  }

  const igUserId = profile?.user_id || profile?.id || shortToken.user_id;
  if (!igUserId) throw new Error('Instagram nao retornou o ID da conta profissional conectada');

  const now = Date.now();
  return savePlatformToken('instagram', {
    authMode: 'instagram_login',
    accessToken: longToken.accessToken,
    tokenType: longToken.tokenType,
    igUserId: String(igUserId),
    username: profile?.username || null,
    permissions: shortToken.permissions || INSTAGRAM_SCOPES.join(','),
    expiresAt: longToken.expiresIn ? now + (longToken.expiresIn * 1000) : null,
    connectedAt: new Date(now).toISOString(),
  });
}

async function waitForInstagramContainer(containerId, accessToken) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await axios.get(`https://graph.instagram.com/${graphVersion()}/${containerId}`, {
      params: { fields: 'status_code,status', access_token: accessToken },
      timeout: 30_000,
    });
    const status = res.data.status_code;
    if (status === 'FINISHED') return res.data;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram recusou a midia: ${res.data.status || status}`);
    }
    await sleep(3000);
  }
  throw new Error('O Instagram nao terminou de processar a midia dentro do tempo limite');
}

export async function publishInstagram({ mediaUrl, mediaKind, caption }) {
  const stored = await getValidInstagramConnection();
  if (!mediaUrl) throw new Error('Instagram exige uma URL publica da midia');
  if (!['image', 'video'].includes(mediaKind)) throw new Error('Neste MVP, Instagram aceita imagem ou video');

  const params = {
    caption: caption || '',
    access_token: stored.accessToken,
  };
  if (mediaKind === 'video') {
    params.media_type = 'REELS';
    params.video_url = mediaUrl;
    params.share_to_feed = 'true';
  } else {
    params.image_url = mediaUrl;
  }

  const createRes = await axios.post(
    `https://graph.instagram.com/${graphVersion()}/${stored.igUserId}/media`,
    null,
    { params, timeout: 30_000 },
  );
  const creationId = createRes.data.id;
  if (!creationId) throw new Error('Instagram nao retornou o ID do container de midia');

  await waitForInstagramContainer(creationId, stored.accessToken);

  const publishRes = await axios.post(
    `https://graph.instagram.com/${graphVersion()}/${stored.igUserId}/media_publish`,
    null,
    {
      params: { creation_id: creationId, access_token: stored.accessToken },
      timeout: 30_000,
    },
  );

  const mediaId = publishRes.data.id;
  let permalink = null;
  if (mediaId) {
    try {
      const info = await axios.get(`https://graph.instagram.com/${graphVersion()}/${mediaId}`, {
        params: { fields: 'permalink', access_token: stored.accessToken },
        timeout: 20_000,
      });
      permalink = info.data.permalink || null;
    } catch {
      // Publishing already succeeded; a missing permalink should not turn it into a failure.
    }
  }

  return { id: mediaId || null, url: permalink };
}

// ---------------------------------------------------------------------------
// LinkedIn OAuth + Posts / Images / Videos APIs
// ---------------------------------------------------------------------------

export function getLinkedInAuthUrl(state) {
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', required(getRuntimeConfig().linkedin.clientId, 'LinkedIn Client ID'));
  url.searchParams.set('redirect_uri', linkedinRedirectUri());
  url.searchParams.set('scope', getRuntimeConfig().linkedin.scopes);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function handleLinkedInCallback(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: linkedinRedirectUri(),
    client_id: required(getRuntimeConfig().linkedin.clientId, 'LinkedIn Client ID'),
    client_secret: required(getRuntimeConfig().linkedin.clientSecret, 'LinkedIn Client Secret'),
  });

  const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });
  const accessToken = tokenRes.data.access_token;
  const profileRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30_000,
  });

  const memberId = profileRes.data.sub;
  if (!memberId) throw new Error('LinkedIn nao retornou o identificador OIDC do usuario');
  const authorUrn = getRuntimeConfig().linkedin.authorUrn || `urn:li:person:${memberId}`;
  const expiresIn = Number(tokenRes.data.expires_in || 0);

  return savePlatformToken('linkedin', {
    accessToken,
    expiresIn,
    expiry_at: expiresIn ? Date.now() + expiresIn * 1000 : null,
    memberId,
    authorUrn,
    name: profileRes.data.name || profileRes.data.given_name || 'LinkedIn',
    connectedAt: new Date().toISOString(),
  });
}

function getLinkedInStoredToken() {
  const stored = getTokens().linkedin;
  if (!stored) throw new Error('LinkedIn nao esta conectado');
  if (stored.expiry_at && stored.expiry_at <= Date.now() + 60_000) {
    throw new Error('Token do LinkedIn expirou. Reconecte o LinkedIn para publicar novamente.');
  }
  return stored;
}

async function putStream(url, filePath, { start, end, headers = {} } = {}) {
  const stat = fs.statSync(filePath);
  const first = Number.isFinite(start) ? start : 0;
  const last = Number.isFinite(end) ? end : stat.size - 1;
  const stream = fs.createReadStream(filePath, { start: first, end: last });
  return axios.put(url, stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(last - first + 1),
      ...headers,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 180_000,
  });
}

async function waitForLinkedInImage(imageUrn, token) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const res = await axios.get(`https://api.linkedin.com/rest/images/${encodeURIComponent(imageUrn)}`, {
        headers: linkedinHeaders(token),
        timeout: 30_000,
      });
      const status = res.data.status;
      if (status === 'AVAILABLE') return res.data;
      if (status === 'PROCESSING_FAILED') {
        throw new Error('LinkedIn falhou ao processar a imagem');
      }
    } catch (error) {
      // w_member_social is write-only on versioned Images GET calls. In that
      // common self-service case, continue without turning a successful upload
      // into a failure merely because status lookup is forbidden.
      if (error?.response?.status === 403) return null;
      if (error?.message?.startsWith('LinkedIn falhou')) throw error;
      if (attempt === 29) throw axiosApiError(error, 'Falha ao consultar processamento da imagem no LinkedIn');
    }
    await sleep(1000);
  }
  return null;
}

async function uploadLinkedInImage(filePath, ownerUrn, token) {
  const initRes = await axios.post(
    'https://api.linkedin.com/rest/images?action=initializeUpload',
    { initializeUploadRequest: { owner: ownerUrn } },
    { headers: linkedinHeaders(token, { 'Content-Type': 'application/json' }), timeout: 30_000 },
  );
  const { uploadUrl, image } = initRes.data.value || {};
  if (!uploadUrl || !image) throw new Error('LinkedIn nao retornou dados para upload da imagem');

  // LinkedIn requires the OAuth token on the image upload PUT. This differs
  // from the Videos API upload URLs, which do not take the OAuth header.
  await putStream(uploadUrl, filePath, { headers: { Authorization: `Bearer ${token}` } });
  await waitForLinkedInImage(image, token);
  return image;
}

async function waitForLinkedInVideo(videoUrn, token) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await axios.get(`https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`, {
        headers: linkedinHeaders(token),
        timeout: 30_000,
      });
      const status = res.data.status;
      if (status === 'AVAILABLE') return res.data;
      if (status === 'PROCESSING_FAILED') {
        throw new Error(`LinkedIn falhou ao processar o video: ${res.data.processingFailureReason || status}`);
      }
    } catch (error) {
      if (error?.response?.status === 403) return null;
      if (error?.message?.startsWith('LinkedIn falhou')) throw error;
      if (attempt === 39) throw axiosApiError(error, 'Falha ao consultar processamento do video no LinkedIn');
    }
    await sleep(3000);
  }
  throw new Error('LinkedIn nao concluiu o processamento do video dentro do tempo limite');
}

async function uploadLinkedInVideo(filePath, ownerUrn, token) {
  const fileSize = fs.statSync(filePath).size;
  const initRes = await axios.post(
    'https://api.linkedin.com/rest/videos?action=initializeUpload',
    {
      initializeUploadRequest: {
        owner: ownerUrn,
        fileSizeBytes: fileSize,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    },
    { headers: linkedinHeaders(token, { 'Content-Type': 'application/json' }), timeout: 30_000 },
  );

  const { video, uploadToken = '', uploadInstructions = [] } = initRes.data.value || {};
  if (!video || !uploadInstructions.length) throw new Error('LinkedIn nao retornou instrucoes para upload do video');

  const uploadedPartIds = [];
  for (const part of uploadInstructions) {
    let response;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await putStream(part.uploadUrl, filePath, {
          start: Number(part.firstByte),
          end: Number(part.lastByte),
        });
        break;
      } catch (error) {
        if (attempt >= 3) throw axiosApiError(error, 'Falha no upload de uma parte do video para o LinkedIn');
        await sleep(attempt * 750);
      }
    }
    const etag = response?.headers?.etag || response?.headers?.ETag;
    if (!etag) throw new Error('LinkedIn nao retornou ETag para uma parte do video');
    uploadedPartIds.push(String(etag).replace(/^"|"$/g, ''));
  }

  await axios.post(
    'https://api.linkedin.com/rest/videos?action=finalizeUpload',
    { finalizeUploadRequest: { video, uploadToken, uploadedPartIds } },
    { headers: linkedinHeaders(token, { 'Content-Type': 'application/json' }), timeout: 30_000 },
  );

  await waitForLinkedInVideo(video, token);
  return video;
}

export async function publishLinkedIn({ filePath, mediaKind, caption, title }) {
  const stored = getLinkedInStoredToken();
  const authorUrn = getRuntimeConfig().linkedin.authorUrn || stored.authorUrn;
  const token = stored.accessToken;
  const body = {
    author: authorUrn,
    commentary: caption || '',
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (mediaKind === 'image') {
    if (!filePath) throw new Error('LinkedIn exige arquivo local para post com imagem neste MVP');
    const imageUrn = await uploadLinkedInImage(filePath, authorUrn, token);
    body.content = { media: { id: imageUrn, altText: (title || 'Imagem do post').slice(0, 4086) } };
  } else if (mediaKind === 'video') {
    if (!filePath) throw new Error('LinkedIn exige arquivo local para post com video neste MVP');
    const videoUrn = await uploadLinkedInVideo(filePath, authorUrn, token);
    body.content = { media: { id: videoUrn, title: (title || 'Video').slice(0, 200) } };
  }

  try {
    const res = await axios.post('https://api.linkedin.com/rest/posts', body, {
      headers: linkedinHeaders(token, { 'Content-Type': 'application/json' }),
      timeout: 45_000,
    });
    const id = res.headers['x-restli-id'] || null;
    return { id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
  } catch (error) {
    throw axiosApiError(error, 'Falha ao criar post no LinkedIn');
  }
}


// ---------------------------------------------------------------------------
// TikTok Login Kit + Content Posting API
// ---------------------------------------------------------------------------

function tiktokRedirectUri() {
  return getRuntimeConfig().tiktok.redirectUri;
}

export function getTikTokAuthUrl(state) {
  const cfg = getRuntimeConfig().tiktok;
  if (!String(cfg.redirectUri || '').startsWith('https://')) {
    throw new Error('TikTok exige callback HTTPS. Configure uma URL HTTPS em Configuracoes > URL do aplicativo.');
  }
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', required(cfg.clientKey, 'TikTok Client Key'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scopes || 'user.info.basic,video.publish');
  url.searchParams.set('redirect_uri', tiktokRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeTikTokToken(params) {
  const cfg = getRuntimeConfig().tiktok;
  const body = new URLSearchParams({
    client_key: required(cfg.clientKey, 'TikTok Client Key'),
    client_secret: required(cfg.clientSecret, 'TikTok Client Secret'),
    ...params,
  });
  try {
    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30_000,
    });
    return res.data;
  } catch (error) {
    throw axiosApiError(error, 'Falha ao obter token do TikTok');
  }
}

export async function handleTikTokCallback(code) {
  const data = await exchangeTikTokToken({
    code: String(code),
    grant_type: 'authorization_code',
    redirect_uri: tiktokRedirectUri(),
  });
  if (!data?.access_token) throw new Error('TikTok nao retornou access token');

  let user = null;
  try {
    const info = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
      params: { fields: 'open_id,avatar_url,display_name' },
      headers: { Authorization: `Bearer ${data.access_token}` },
      timeout: 30_000,
    });
    user = info.data?.data?.user || null;
  } catch {
    // A conexao continua valida mesmo se a leitura amigavel do perfil falhar.
  }

  return savePlatformToken('tiktok', {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    accessExpiresAt: Date.now() + Number(data.expires_in || 86400) * 1000,
    refreshExpiresAt: Date.now() + Number(data.refresh_expires_in || 31536000) * 1000,
    openId: data.open_id || user?.open_id || null,
    scopes: data.scope || '',
    displayName: user?.display_name || 'TikTok',
    connectedAt: new Date().toISOString(),
  });
}

async function getTikTokConnection() {
  let stored = getTokens().tiktok;
  if (!stored?.accessToken) throw new Error('TikTok nao esta conectado');
  if (!stored.accessExpiresAt || stored.accessExpiresAt > Date.now() + 60_000) return stored;
  if (!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now() + 60_000)) {
    throw new Error('A conexao do TikTok expirou. Reconecte a conta.');
  }
  const data = await exchangeTikTokToken({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
  });
  stored = savePlatformToken('tiktok', {
    ...stored,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || stored.refreshToken,
    accessExpiresAt: Date.now() + Number(data.expires_in || 86400) * 1000,
    refreshExpiresAt: Date.now() + Number(data.refresh_expires_in || 31536000) * 1000,
    scopes: data.scope || stored.scopes,
  });
  return stored;
}

function postTikTokCreatorInfoRaw(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:',
      hostname: 'open.tiktokapis.com',
      port: 443,
      path: '/v2/post/publish/creator_info/query/',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: '*/*',
      },
      timeout: 30_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          return reject(new Error(`TikTok retornou uma resposta invalida (HTTP ${res.statusCode || 0})`));
        }

        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const error = tiktokApiError(data, `TikTok HTTP ${res.statusCode}`, { stage: 'creator_info' });
          error.status = res.statusCode;
          return reject(error);
        }

        resolve(data);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Tempo limite ao consultar opcoes de publicacao do TikTok')));
    req.on('error', reject);

    // TikTok creator_info/query exige POST sem corpo. Nao chame req.write()
    // nem defina Content-Length; alguns clientes HTTP geram invalid_params aqui.
    req.end();
  });
}

export async function getTikTokCreatorInfo() {
  const stored = await getTikTokConnection();
  try {
    const data = await postTikTokCreatorInfoRaw(stored.accessToken);
    return assertTikTokOk(data, 'Falha ao consultar opcoes de publicacao do TikTok', { stage: 'creator_info' });
  } catch (error) {
    if (error?.status || error?.code) throw error;
    throw new Error(error?.message || 'Falha ao consultar opcoes de publicacao do TikTok');
  }
}

function tiktokChunkPlan(fileSize) {
  if (fileSize <= 64 * MB) return { chunkSize: fileSize, count: 1 };
  const chunkSize = 32 * MB;
  const count = Math.max(2, Math.floor(fileSize / chunkSize));
  return { chunkSize, count };
}

async function uploadTikTokVideo(uploadUrl, filePath, mimeType) {
  const fileSize = fs.statSync(filePath).size;
  const { chunkSize, count } = tiktokChunkPlan(fileSize);
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const isLast = index === count - 1;
    const end = isLast ? fileSize - 1 : Math.min(offset + chunkSize - 1, fileSize - 1);
    const stream = fs.createReadStream(filePath, { start: offset, end });
    const response = await axios.put(uploadUrl, stream, {
      headers: {
        'Content-Type': mimeType || 'video/mp4',
        'Content-Length': String(end - offset + 1),
        'Content-Range': `bytes ${offset}-${end}/${fileSize}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180_000,
      validateStatus: (status) => status === 201 || status === 206,
    });
    if (!isLast && response.status !== 206) throw new Error('TikTok encerrou o upload antes da ultima parte');
    if (isLast && response.status !== 201) throw new Error('TikTok nao confirmou o fim do upload');
    offset = end + 1;
  }
}

async function waitForTikTokPublish(publishId, token) {
  let last = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let res;
    try {
      res = await axios.post('https://open.tiktokapis.com/v2/post/publish/status/fetch/', { publish_id: publishId }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        timeout: 30_000,
      });
    } catch (error) {
      throw tiktokApiError(error, 'Falha ao consultar o status da publicacao no TikTok', { stage: 'status_fetch', publishId });
    }
    const statusData = assertTikTokOk(res.data, 'Falha ao consultar o status da publicacao no TikTok', { stage: 'status_fetch', publishId });
    last = statusData || {};
    if (last.status === 'PUBLISH_COMPLETE') return last;
    if (last.status === 'FAILED') {
      const error = tiktokApiError(res.data, `TikTok recusou a publicacao: ${last.fail_reason || 'falha desconhecida'}`, {
        stage: 'processing',
        publishId,
      });
      error.code = last.fail_reason || error.code || 'publish_failed';
      error.message = `TikTok recusou a publicacao: ${last.fail_reason || 'falha desconhecida'}`;
      throw error;
    }
    await sleep(2000);
  }
  return last || { status: 'PROCESSING' };
}

export async function publishTikTok({ filePath, mediaUrl, mediaKind, caption, privacyLevel, mimeType, brandOrganic = false, brandContent = false, isAigc = false, allowComment = false, allowDuet = false, allowStitch = false }) {
  const stored = await getTikTokConnection();
  const creator = await getTikTokCreatorInfo();
  const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
  if (!privacyLevel) throw new Error('Selecione manualmente a privacidade do TikTok');
  const privacy = privacyLevel;
  if (options.length && !options.includes(privacy)) throw new Error('Privacidade escolhida nao esta disponivel para esta conta TikTok');

  let init;
  if (mediaKind === 'video') {
    if (!filePath) throw new Error('TikTok exige arquivo local para video neste MVP');
    const fileSize = fs.statSync(filePath).size;
    const { chunkSize, count } = tiktokChunkPlan(fileSize);
    const body = {
      post_info: {
        title: (caption || '').slice(0, 2200),
        privacy_level: privacy,
        disable_comment: Boolean(creator.comment_disabled) || !allowComment,
        disable_duet: Boolean(creator.duet_disabled) || !allowDuet,
        disable_stitch: Boolean(creator.stitch_disabled) || !allowStitch,
        brand_content_toggle: Boolean(brandContent),
        brand_organic_toggle: Boolean(brandOrganic),
        is_aigc: Boolean(isAigc),
      },
      source_info: { source: 'FILE_UPLOAD', video_size: fileSize, chunk_size: chunkSize, total_chunk_count: count },
    };
    let res;
    try {
      res = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', body, {
        headers: { Authorization: `Bearer ${stored.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        timeout: 30_000,
      });
    } catch (error) {
      throw tiktokApiError(error, 'Falha ao iniciar o Direct Post de video no TikTok', { stage: 'video_init' });
    }
    init = assertTikTokOk(res.data, 'Falha ao iniciar o Direct Post de video no TikTok', { stage: 'video_init' });
    if (!init?.upload_url || !init?.publish_id) throw new Error('TikTok nao retornou URL/ID de upload');
    await uploadTikTokVideo(init.upload_url, filePath, mimeType || 'video/mp4');
  } else if (mediaKind === 'image') {
    if (!mediaUrl) throw new Error('TikTok exige URL HTTPS verificada para publicar foto');
    const body = {
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
      post_info: {
        title: '',
        description: (caption || '').slice(0, 4000),
        privacy_level: privacy,
        disable_comment: Boolean(creator.comment_disabled) || !allowComment,
        auto_add_music: false,
        brand_content_toggle: Boolean(brandContent),
        brand_organic_toggle: Boolean(brandOrganic),
      },
      source_info: { source: 'PULL_FROM_URL', photo_images: [mediaUrl], photo_cover_index: 0 },
      is_aigc: Boolean(isAigc),
    };
    let res;
    try {
      res = await axios.post('https://open.tiktokapis.com/v2/post/publish/content/init/', body, {
        headers: { Authorization: `Bearer ${stored.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        timeout: 30_000,
      });
    } catch (error) {
      throw tiktokApiError(error, 'Falha ao iniciar o Direct Post de foto no TikTok', { stage: 'photo_init' });
    }
    init = assertTikTokOk(res.data, 'Falha ao iniciar o Direct Post de foto no TikTok', { stage: 'photo_init' });
    if (!init?.publish_id) throw new Error('TikTok nao retornou publish_id');
  } else {
    throw new Error('TikTok aceita video ou foto, nao post de texto puro');
  }

  const status = await waitForTikTokPublish(init.publish_id, stored.accessToken);
  const postId = status?.publicaly_available_post_id?.[0] || null;
  return {
    id: postId ? String(postId) : init.publish_id,
    url: null,
    message: status?.status === 'PUBLISH_COMPLETE' ? 'Publicado no TikTok' : `TikTok recebeu o post; status: ${status?.status || 'PROCESSING'}`,
  };
}

// ---------------------------------------------------------------------------
// Facebook Pages API
// ---------------------------------------------------------------------------

function facebookRedirectUri() {
  return getRuntimeConfig().facebook.redirectUri;
}

function facebookVersion() {
  return getRuntimeConfig().facebook.graphVersion;
}

export function getFacebookAuthUrl(state) {
  const cfg = getRuntimeConfig().facebook;
  const url = new URL(`https://www.facebook.com/${facebookVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', required(cfg.appId, 'Facebook App ID'));
  url.searchParams.set('redirect_uri', facebookRedirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scopes);
  return url.toString();
}

export async function handleFacebookCallback(code) {
  const cfg = getRuntimeConfig().facebook;
  let shortToken;
  try {
    const res = await axios.get(`https://graph.facebook.com/${facebookVersion()}/oauth/access_token`, {
      params: {
        client_id: required(cfg.appId, 'Facebook App ID'),
        client_secret: required(cfg.appSecret, 'Facebook App Secret'),
        redirect_uri: facebookRedirectUri(),
        code: String(code),
      },
      timeout: 30_000,
    });
    shortToken = res.data?.access_token;
  } catch (error) {
    throw axiosApiError(error, 'Falha ao trocar codigo do Facebook');
  }
  if (!shortToken) throw new Error('Facebook nao retornou access token');

  let userToken = shortToken;
  try {
    const long = await axios.get(`https://graph.facebook.com/${facebookVersion()}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: 30_000,
    });
    userToken = long.data?.access_token || shortToken;
  } catch {
    // Token curto ainda permite concluir o setup e testar.
  }

  const pagesRes = await axios.get(`https://graph.facebook.com/${facebookVersion()}/me/accounts`, {
    params: { fields: 'id,name,access_token,tasks', access_token: userToken, limit: 100 },
    timeout: 30_000,
  });
  const pages = (pagesRes.data?.data || []).map((page) => ({
    id: String(page.id), name: page.name || `Pagina ${page.id}`, accessToken: page.access_token, tasks: page.tasks || [],
  }));
  if (!pages.length) throw new Error('Facebook nao retornou nenhuma Pagina administrada por esta conta');

  const configuredPage = cfg.pageId && pages.find((page) => page.id === cfg.pageId);
  const contentPage = pages.find((page) => page.tasks?.some((task) => String(task).includes('CREATE_CONTENT')));
  const selected = configuredPage || contentPage || pages[0];
  return savePlatformToken('facebook', {
    userAccessToken: userToken,
    pages,
    selectedPageId: selected.id,
    selectedPageName: selected.name,
    connectedAt: new Date().toISOString(),
  });
}

function getFacebookPage() {
  const stored = getTokens().facebook;
  if (!stored?.pages?.length) throw new Error('Facebook nao esta conectado');
  const configured = getRuntimeConfig().facebook.pageId;
  const page = stored.pages.find((item) => item.id === configured)
    || stored.pages.find((item) => item.id === stored.selectedPageId)
    || stored.pages[0];
  if (!page?.accessToken) throw new Error('Facebook nao possui Page Access Token para a pagina selecionada');
  return page;
}

export async function publishFacebook({ filePath, mediaUrl, mediaKind, caption, title }) {
  const page = getFacebookPage();
  const token = page.accessToken;
  const graph = `https://graph.facebook.com/${facebookVersion()}`;
  if (mediaKind === 'text') {
    const res = await axios.post(`${graph}/${page.id}/feed`, null, {
      params: { message: caption || title || '', access_token: token },
      timeout: 30_000,
    });
    return { id: res.data?.id || null, url: res.data?.id ? `https://www.facebook.com/${res.data.id}` : `https://www.facebook.com/${page.id}` };
  }
  if (mediaKind === 'image') {
    if (!mediaUrl) throw new Error('Facebook precisa de URL publica para a imagem neste MVP');
    const res = await axios.post(`${graph}/${page.id}/photos`, null, {
      params: { url: mediaUrl, caption: caption || title || '', published: 'true', access_token: token },
      timeout: 60_000,
    });
    return { id: res.data?.post_id || res.data?.id || null, url: `https://www.facebook.com/${page.id}` };
  }
  if (mediaKind === 'video') {
    if (!filePath) throw new Error('Facebook precisa do arquivo local para publicar Reel neste MVP');
    const size = fs.statSync(filePath).size;
    const start = await axios.post(`${graph}/${page.id}/video_reels`, null, {
      params: { access_token: token, upload_phase: 'start' }, timeout: 30_000,
    });
    const videoId = start.data?.video_id;
    const uploadUrl = start.data?.upload_url;
    if (!videoId || !uploadUrl) throw new Error('Facebook nao iniciou o upload do Reel');
    await axios.post(uploadUrl, fs.createReadStream(filePath), {
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180_000,
    });
    await axios.post(`${graph}/${page.id}/video_reels`, null, {
      params: {
        access_token: token,
        video_id: videoId,
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: caption || '',
        title: title || '',
      },
      timeout: 45_000,
    });
    return { id: videoId, url: `https://www.facebook.com/${page.id}` };
  }
  throw new Error('Formato nao suportado pelo Facebook');
}

// ---------------------------------------------------------------------------
// Google Business Profile (Google Meu Negocio)
// ---------------------------------------------------------------------------

function googleBusinessRedirectUri() {
  return getRuntimeConfig().googleBusiness.redirectUri;
}

export function getGoogleBusinessAuthUrl(state) {
  const cfg = getRuntimeConfig().googleBusiness;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', required(cfg.clientId, 'Google Business Client ID'));
  url.searchParams.set('redirect_uri', googleBusinessRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/business.manage');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeGoogleBusinessToken(params) {
  const cfg = getRuntimeConfig().googleBusiness;
  const body = new URLSearchParams({
    client_id: required(cfg.clientId, 'Google Business Client ID'),
    client_secret: required(cfg.clientSecret, 'Google Business Client Secret'),
    ...params,
  });
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30_000,
    });
    return res.data;
  } catch (error) {
    throw axiosApiError(error, 'Falha ao obter token do Perfil da Empresa');
  }
}

async function listGoogleBusinessLocations(accessToken) {
  const accounts = [];
  let accountPageToken = '';
  do {
    const accountsRes = await axios.get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      params: accountPageToken ? { pageToken: accountPageToken } : {},
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30_000,
    });
    accounts.push(...(accountsRes.data?.accounts || []));
    accountPageToken = accountsRes.data?.nextPageToken || '';
  } while (accountPageToken);

  const locations = [];
  for (const account of accounts) {
    try {
      let pageToken = '';
      do {
        const locRes = await axios.get(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`, {
          params: { readMask: 'name,title,storeCode,metadata', pageSize: 100, ...(pageToken ? { pageToken } : {}) },
          headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30_000,
        });
        for (const loc of locRes.data?.locations || []) {
          locations.push({
            name: loc.name,
            title: loc.title || loc.storeCode || loc.name,
            storeCode: loc.storeCode || null,
            placeId: loc.metadata?.placeId || null,
            accountName: account.name,
            accountLabel: account.accountName || account.name,
          });
        }
        pageToken = locRes.data?.nextPageToken || '';
      } while (pageToken);
    } catch {
      // Uma conta sem locais ou sem permissao nao deve impedir as outras.
    }
  }
  return { accounts, locations };
}

export async function handleGoogleBusinessCallback(code) {
  const data = await exchangeGoogleBusinessToken({
    code: String(code), redirect_uri: googleBusinessRedirectUri(), grant_type: 'authorization_code',
  });
  const accessToken = data.access_token;
  if (!accessToken) throw new Error('Google nao retornou access token para o Perfil da Empresa');
  const previous = getTokens().googleBusiness || {};
  const listing = await listGoogleBusinessLocations(accessToken);
  const cfg = getRuntimeConfig().googleBusiness;
  const selected = listing.locations.find((loc) => loc.name === cfg.locationName)
    || listing.locations.find((loc) => loc.accountName === cfg.accountName)
    || listing.locations[0]
    || null;
  return savePlatformToken('googleBusiness', {
    accessToken,
    refreshToken: data.refresh_token || previous.refreshToken || null,
    expiryAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    accounts: listing.accounts.map((item) => ({ name: item.name, accountName: item.accountName, type: item.type })),
    locations: listing.locations,
    selectedLocationName: selected?.name || null,
    selectedAccountName: selected?.accountName || null,
    selectedLocationTitle: selected?.title || null,
    connectedAt: new Date().toISOString(),
  });
}

async function getGoogleBusinessConnection() {
  let stored = getTokens().googleBusiness;
  if (!stored) throw new Error('Perfil da Empresa no Google nao esta conectado');
  if (stored.accessToken && (!stored.expiryAt || stored.expiryAt > Date.now() + 60_000)) return stored;
  if (!stored.refreshToken) throw new Error('Token do Perfil da Empresa expirou. Reconecte a conta Google.');
  const data = await exchangeGoogleBusinessToken({ refresh_token: stored.refreshToken, grant_type: 'refresh_token' });
  stored = savePlatformToken('googleBusiness', {
    ...stored,
    accessToken: data.access_token,
    expiryAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return stored;
}

function pickGoogleBusinessLocation(stored) {
  const cfg = getRuntimeConfig().googleBusiness;
  return stored.locations?.find((loc) => loc.name === cfg.locationName)
    || stored.locations?.find((loc) => loc.name === stored.selectedLocationName)
    || stored.locations?.[0]
    || null;
}

export async function publishGoogleBusiness({ mediaUrl, mediaKind, caption, title }) {
  const stored = await getGoogleBusinessConnection();
  const location = pickGoogleBusinessLocation(stored);
  if (!location) throw new Error('Nenhuma unidade do Perfil da Empresa foi encontrada/selecionada');
  if (mediaKind === 'video') throw new Error('Neste MVP, Google Meu Negocio publica texto ou foto');
  const body = {
    languageCode: 'pt-BR',
    summary: caption || title || '',
    topicType: 'STANDARD',
  };
  if (mediaKind === 'image') {
    if (!mediaUrl) throw new Error('Post com foto no Google Meu Negocio exige URL publica da imagem');
    body.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];
  }
  const parent = `${location.accountName}/${location.name}`;
  const res = await axios.post(`https://mybusiness.googleapis.com/v4/${parent}/localPosts`, body, {
    headers: { Authorization: `Bearer ${stored.accessToken}`, 'Content-Type': 'application/json' },
    timeout: 45_000,
  });
  return { id: res.data?.name || null, url: res.data?.searchUrl || null };
}

export function connectionSummary() {
  const tokens = getTokens();
  const runtime = getRuntimeConfig();
  const linkedinExpired = Boolean(tokens.linkedin?.expiry_at && tokens.linkedin.expiry_at <= Date.now() + 60_000);
  const tiktokExpired = Boolean(tokens.tiktok?.accessExpiresAt && tokens.tiktok.accessExpiresAt <= Date.now() + 60_000 && (!tokens.tiktok?.refreshToken || (tokens.tiktok?.refreshExpiresAt && tokens.tiktok.refreshExpiresAt <= Date.now() + 60_000)));
  const gbpExpired = Boolean(tokens.googleBusiness?.expiryAt && tokens.googleBusiness.expiryAt <= Date.now() + 60_000 && !tokens.googleBusiness?.refreshToken);
  const facebookSelected = tokens.facebook?.pages?.find((page) => page.id === runtime.facebook.pageId)
    || tokens.facebook?.pages?.find((page) => page.id === tokens.facebook?.selectedPageId)
    || tokens.facebook?.pages?.[0];
  const gbpSelected = tokens.googleBusiness?.locations?.find((loc) => loc.name === runtime.googleBusiness.locationName)
    || tokens.googleBusiness?.locations?.find((loc) => loc.name === tokens.googleBusiness?.selectedLocationName)
    || tokens.googleBusiness?.locations?.[0];
  return {
    youtube: {
      connected: Boolean(tokens.youtube),
      name: tokens.youtube?.channelName || null,
      configured: Boolean(runtime.youtube.clientId && runtime.youtube.clientSecret),
      expiresAt: tokens.youtube?.expiry_at || null,
      canRefresh: Boolean(tokens.youtube?.refresh_token),
    },
    instagram: {
      connected: Boolean(tokens.instagram?.authMode === 'instagram_login' && tokens.instagram?.accessToken && tokens.instagram?.igUserId
        && (!tokens.instagram?.expiresAt || tokens.instagram.expiresAt > Date.now() + 60_000)),
      expired: Boolean(tokens.instagram?.expiresAt && tokens.instagram.expiresAt <= Date.now() + 60_000),
      needsReconnect: Boolean(tokens.instagram && tokens.instagram?.authMode !== 'instagram_login'),
      name: tokens.instagram?.username ? `@${tokens.instagram.username}` : null,
      configured: Boolean(runtime.instagram.appId && runtime.instagram.appSecret),
      expiresAt: tokens.instagram?.expiresAt || null,
    },
    linkedin: {
      connected: Boolean(tokens.linkedin) && !linkedinExpired,
      expired: linkedinExpired,
      name: tokens.linkedin?.name || null,
      configured: Boolean(runtime.linkedin.clientId && runtime.linkedin.clientSecret),
      expiresAt: tokens.linkedin?.expiry_at || null,
    },
    tiktok: {
      connected: Boolean(tokens.tiktok?.accessToken) && !tiktokExpired,
      expired: tiktokExpired,
      name: tokens.tiktok?.displayName || null,
      configured: Boolean(runtime.tiktok.clientKey && runtime.tiktok.clientSecret),
      expiresAt: tokens.tiktok?.accessExpiresAt || null,
    },
    facebook: {
      connected: Boolean(tokens.facebook?.pages?.length && facebookSelected?.accessToken),
      name: facebookSelected?.name || null,
      configured: Boolean(runtime.facebook.appId && runtime.facebook.appSecret),
      pages: (tokens.facebook?.pages || []).map((page) => ({ id: page.id, name: page.name, tasks: page.tasks || [] })),
      selectedPageId: facebookSelected?.id || null,
    },
    googleBusiness: {
      connected: Boolean(tokens.googleBusiness?.accessToken) && !gbpExpired && Boolean(gbpSelected),
      expired: gbpExpired,
      name: gbpSelected?.title || null,
      configured: Boolean(runtime.googleBusiness.clientId && runtime.googleBusiness.clientSecret),
      expiresAt: tokens.googleBusiness?.expiryAt || null,
      locations: (tokens.googleBusiness?.locations || []).map((loc) => ({ name: loc.name, title: loc.title, accountName: loc.accountName, accountLabel: loc.accountLabel, placeId: loc.placeId })),
      selectedLocationName: gbpSelected?.name || null,
    },
  };
}
