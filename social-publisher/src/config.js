import { getAppSettings, saveAppSettings } from './store.js';

const trim = (value) => String(value ?? '').trim();
const stripSlash = (value) => trim(value).replace(/\/+$/, '');

function boolValue(storedValue, envValue, fallback) {
  if (typeof storedValue === 'boolean') return storedValue;
  if (envValue !== undefined) return String(envValue).toLowerCase() !== 'false';
  return fallback;
}

function numberValue(storedValue, envValue, fallback, min, max) {
  const raw = storedValue ?? envValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function storedOrEnv(storedValue, envValue, fallback = '') {
  const stored = trim(storedValue);
  if (stored) return stored;
  const env = trim(envValue);
  return env || fallback;
}

function normalizedBasePath(value) {
  const clean = trim(value || '/social').replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '/social';
}

export function getRuntimeConfig() {
  const settings = getAppSettings();
  const port = Number(process.env.PORT || 8000);
  const socialBasePath = normalizedBasePath(process.env.SOCIAL_BASE_PATH);
  const workspaceBaseUrl = stripSlash(process.env.SERVER_URL || `http://localhost:${port}`);
  const integratedBaseUrl = stripSlash(process.env.SOCIAL_PUBLISHER_BASE_URL || `${workspaceBaseUrl}${socialBasePath}`);
  const appBaseUrl = stripSlash(storedOrEnv(settings.general?.appBaseUrl, process.env.APP_BASE_URL, integratedBaseUrl));
  const publicBaseUrl = stripSlash(storedOrEnv(settings.general?.publicBaseUrl, process.env.PUBLIC_BASE_URL, appBaseUrl));
  const hasStoredAppBase = Boolean(trim(settings.general?.appBaseUrl));

  const callback = (stored, env, path) => trim(stored) || (!hasStoredAppBase && trim(env)) || `${appBaseUrl}${path}`;

  const youtube = {
    clientId: storedOrEnv(settings.youtube?.clientId, process.env.GOOGLE_CLIENT_ID),
    clientSecret: storedOrEnv(settings.youtube?.clientSecret, process.env.GOOGLE_CLIENT_SECRET),
    redirectUri: callback(settings.youtube?.redirectUri, process.env.GOOGLE_REDIRECT_URI, '/auth/youtube/callback'),
    chunkMb: numberValue(settings.youtube?.chunkMb, process.env.YOUTUBE_CHUNK_MB, 8, 1, 64),
  };

  const instagram = {
    appId: storedOrEnv(settings.instagram?.appId, process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID),
    appSecret: storedOrEnv(settings.instagram?.appSecret, process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET),
    redirectUri: callback(settings.instagram?.redirectUri, process.env.INSTAGRAM_REDIRECT_URI || process.env.META_REDIRECT_URI, '/auth/instagram/callback'),
    graphVersion: storedOrEnv(settings.instagram?.graphVersion, process.env.INSTAGRAM_GRAPH_VERSION || process.env.META_GRAPH_VERSION, 'v26.0'),
    scopes: 'instagram_business_basic,instagram_business_content_publish',
  };

  const linkedin = {
    clientId: storedOrEnv(settings.linkedin?.clientId, process.env.LINKEDIN_CLIENT_ID),
    clientSecret: storedOrEnv(settings.linkedin?.clientSecret, process.env.LINKEDIN_CLIENT_SECRET),
    redirectUri: callback(settings.linkedin?.redirectUri, process.env.LINKEDIN_REDIRECT_URI, '/auth/linkedin/callback'),
    scopes: storedOrEnv(settings.linkedin?.scopes, process.env.LINKEDIN_SCOPES, 'openid profile w_member_social'),
    authorUrn: storedOrEnv(settings.linkedin?.authorUrn, process.env.LINKEDIN_AUTHOR_URN),
    version: storedOrEnv(settings.linkedin?.version, process.env.LINKEDIN_VERSION, '202609'),
  };

  const tiktok = {
    clientKey: storedOrEnv(settings.tiktok?.clientKey, process.env.TIKTOK_CLIENT_KEY),
    clientSecret: storedOrEnv(settings.tiktok?.clientSecret, process.env.TIKTOK_CLIENT_SECRET),
    redirectUri: callback(settings.tiktok?.redirectUri, process.env.TIKTOK_REDIRECT_URI, '/auth/tiktok/callback'),
    scopes: storedOrEnv(settings.tiktok?.scopes, process.env.TIKTOK_SCOPES, 'user.info.basic,video.publish'),
    verifiedMediaBaseUrl: stripSlash(storedOrEnv(settings.tiktok?.verifiedMediaBaseUrl, process.env.TIKTOK_VERIFIED_MEDIA_BASE_URL)),
  };

  const facebook = {
    appId: storedOrEnv(settings.facebook?.appId, process.env.FACEBOOK_APP_ID),
    appSecret: storedOrEnv(settings.facebook?.appSecret, process.env.FACEBOOK_APP_SECRET),
    redirectUri: callback(settings.facebook?.redirectUri, process.env.FACEBOOK_REDIRECT_URI, '/auth/facebook/callback'),
    graphVersion: storedOrEnv(settings.facebook?.graphVersion, process.env.FACEBOOK_GRAPH_VERSION, instagram.graphVersion || 'v26.0'),
    scopes: storedOrEnv(settings.facebook?.scopes, process.env.FACEBOOK_SCOPES, 'pages_show_list,pages_read_engagement,pages_manage_posts'),
    pageId: storedOrEnv(settings.facebook?.pageId, process.env.FACEBOOK_PAGE_ID),
  };

  const useYoutubeCredentials = boolValue(settings.googleBusiness?.useYoutubeCredentials, process.env.GBP_USE_YOUTUBE_CREDENTIALS, true);
  const googleBusiness = {
    useYoutubeCredentials,
    clientId: useYoutubeCredentials
      ? (youtube.clientId || storedOrEnv(settings.googleBusiness?.clientId, process.env.GBP_CLIENT_ID))
      : storedOrEnv(settings.googleBusiness?.clientId, process.env.GBP_CLIENT_ID),
    clientSecret: useYoutubeCredentials
      ? (youtube.clientSecret || storedOrEnv(settings.googleBusiness?.clientSecret, process.env.GBP_CLIENT_SECRET))
      : storedOrEnv(settings.googleBusiness?.clientSecret, process.env.GBP_CLIENT_SECRET),
    redirectUri: callback(settings.googleBusiness?.redirectUri, process.env.GBP_REDIRECT_URI, '/auth/google-business/callback'),
    locationName: storedOrEnv(settings.googleBusiness?.locationName, process.env.GBP_LOCATION_NAME),
    accountName: storedOrEnv(settings.googleBusiness?.accountName, process.env.GBP_ACCOUNT_NAME),
  };

  return {
    port,
    demoMode: boolValue(settings.general?.demoMode, process.env.DEMO_MODE, true),
    appBaseUrl,
    publicBaseUrl,
    maxUploadMb: numberValue(settings.general?.maxUploadMb, process.env.MAX_UPLOAD_MB, 4096, 1, 4096),
    youtube,
    instagram,
    linkedin,
    tiktok,
    facebook,
    googleBusiness,
  };
}

export function getSafeSettings() {
  const runtime = getRuntimeConfig();
  return {
    general: {
      demoMode: runtime.demoMode,
      appBaseUrl: runtime.appBaseUrl,
      publicBaseUrl: runtime.publicBaseUrl,
      maxUploadMb: runtime.maxUploadMb,
    },
    youtube: {
      clientId: runtime.youtube.clientId,
      hasClientSecret: Boolean(runtime.youtube.clientSecret),
      redirectUri: runtime.youtube.redirectUri,
      chunkMb: runtime.youtube.chunkMb,
    },
    instagram: {
      appId: runtime.instagram.appId,
      hasAppSecret: Boolean(runtime.instagram.appSecret),
      redirectUri: runtime.instagram.redirectUri,
      graphVersion: runtime.instagram.graphVersion,
      scopes: runtime.instagram.scopes,
      loginMode: 'instagram_login',
    },
    linkedin: {
      clientId: runtime.linkedin.clientId,
      hasClientSecret: Boolean(runtime.linkedin.clientSecret),
      redirectUri: runtime.linkedin.redirectUri,
      scopes: runtime.linkedin.scopes,
      authorUrn: runtime.linkedin.authorUrn,
      version: runtime.linkedin.version,
    },
    tiktok: {
      clientKey: runtime.tiktok.clientKey,
      hasClientSecret: Boolean(runtime.tiktok.clientSecret),
      redirectUri: runtime.tiktok.redirectUri,
      scopes: runtime.tiktok.scopes,
      verifiedMediaBaseUrl: runtime.tiktok.verifiedMediaBaseUrl,
    },
    facebook: {
      appId: runtime.facebook.appId,
      hasAppSecret: Boolean(runtime.facebook.appSecret),
      redirectUri: runtime.facebook.redirectUri,
      graphVersion: runtime.facebook.graphVersion,
      scopes: runtime.facebook.scopes,
      pageId: runtime.facebook.pageId,
    },
    googleBusiness: {
      useYoutubeCredentials: runtime.googleBusiness.useYoutubeCredentials,
      clientId: runtime.googleBusiness.useYoutubeCredentials ? '' : runtime.googleBusiness.clientId,
      hasClientSecret: runtime.googleBusiness.useYoutubeCredentials ? Boolean(runtime.youtube.clientSecret) : Boolean(runtime.googleBusiness.clientSecret),
      redirectUri: runtime.googleBusiness.redirectUri,
      locationName: runtime.googleBusiness.locationName,
      accountName: runtime.googleBusiness.accountName,
    },
  };
}

function normalizeUrl(value, name, { allowEmpty = false } = {}) {
  const clean = stripSlash(value);
  if (!clean && allowEmpty) return '';
  try {
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return clean;
  } catch {
    throw new Error(`${name} precisa ser uma URL http:// ou https:// valida`);
  }
}

function normalizeRedirect(value, name) {
  const clean = trim(value);
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return clean;
  } catch {
    throw new Error(`${name} precisa ser uma URL de callback valida`);
  }
}

function limited(value, name, max = 500) {
  const clean = trim(value);
  if (clean.length > max) throw new Error(`${name} excede ${max} caracteres`);
  return clean;
}

function updateSecret(current, incoming, clear) {
  if (clear === true) return '';
  const clean = trim(incoming);
  return clean || trim(current);
}

export function updateSettings(input = {}) {
  const current = getAppSettings();
  const general = input.general || {};
  const youtube = input.youtube || {};
  const instagram = input.instagram || {};
  const linkedin = input.linkedin || {};
  const tiktok = input.tiktok || {};
  const facebook = input.facebook || {};
  const googleBusiness = input.googleBusiness || {};

  const appBaseUrl = general.appBaseUrl !== undefined
    ? normalizeUrl(general.appBaseUrl, 'URL do aplicativo')
    : trim(current.general?.appBaseUrl);
  const publicBaseUrl = general.publicBaseUrl !== undefined
    ? normalizeUrl(general.publicBaseUrl, 'URL publica de midia')
    : trim(current.general?.publicBaseUrl);

  const next = {
    general: {
      demoMode: typeof general.demoMode === 'boolean' ? general.demoMode : current.general?.demoMode,
      appBaseUrl,
      publicBaseUrl,
      maxUploadMb: numberValue(general.maxUploadMb, current.general?.maxUploadMb, 4096, 1, 4096),
    },
    youtube: {
      clientId: youtube.clientId !== undefined ? limited(youtube.clientId, 'Google Client ID') : trim(current.youtube?.clientId),
      clientSecret: updateSecret(current.youtube?.clientSecret, youtube.clientSecret, youtube.clearClientSecret),
      redirectUri: youtube.redirectUri !== undefined ? normalizeRedirect(youtube.redirectUri, 'Callback do YouTube') : trim(current.youtube?.redirectUri),
      chunkMb: numberValue(youtube.chunkMb, current.youtube?.chunkMb, 8, 1, 64),
    },
    instagram: {
      appId: instagram.appId !== undefined ? limited(instagram.appId, 'Instagram App ID') : trim(current.instagram?.appId),
      appSecret: updateSecret(current.instagram?.appSecret, instagram.appSecret, instagram.clearAppSecret),
      redirectUri: instagram.redirectUri !== undefined ? normalizeRedirect(instagram.redirectUri, 'Callback do Instagram') : trim(current.instagram?.redirectUri),
      graphVersion: instagram.graphVersion !== undefined ? limited(instagram.graphVersion, 'Versao da Graph API', 30) : trim(current.instagram?.graphVersion),
    },
    linkedin: {
      clientId: linkedin.clientId !== undefined ? limited(linkedin.clientId, 'LinkedIn Client ID') : trim(current.linkedin?.clientId),
      clientSecret: updateSecret(current.linkedin?.clientSecret, linkedin.clientSecret, linkedin.clearClientSecret),
      redirectUri: linkedin.redirectUri !== undefined ? normalizeRedirect(linkedin.redirectUri, 'Callback do LinkedIn') : trim(current.linkedin?.redirectUri),
      scopes: linkedin.scopes !== undefined ? limited(linkedin.scopes, 'Escopos do LinkedIn', 1000) : trim(current.linkedin?.scopes),
      authorUrn: linkedin.authorUrn !== undefined ? limited(linkedin.authorUrn, 'Author URN do LinkedIn', 500) : trim(current.linkedin?.authorUrn),
      version: linkedin.version !== undefined ? limited(linkedin.version, 'Versao do LinkedIn', 30) : trim(current.linkedin?.version),
    },
    tiktok: {
      clientKey: tiktok.clientKey !== undefined ? limited(tiktok.clientKey, 'TikTok Client Key') : trim(current.tiktok?.clientKey),
      clientSecret: updateSecret(current.tiktok?.clientSecret, tiktok.clientSecret, tiktok.clearClientSecret),
      redirectUri: tiktok.redirectUri !== undefined ? normalizeRedirect(tiktok.redirectUri, 'Callback do TikTok') : trim(current.tiktok?.redirectUri),
      scopes: tiktok.scopes !== undefined ? limited(tiktok.scopes, 'Scopes do TikTok', 1000) : trim(current.tiktok?.scopes),
      verifiedMediaBaseUrl: tiktok.verifiedMediaBaseUrl !== undefined
        ? normalizeUrl(tiktok.verifiedMediaBaseUrl, 'URL de midia verificada do TikTok', { allowEmpty: true })
        : trim(current.tiktok?.verifiedMediaBaseUrl),
    },
    facebook: {
      appId: facebook.appId !== undefined ? limited(facebook.appId, 'Facebook App ID') : trim(current.facebook?.appId),
      appSecret: updateSecret(current.facebook?.appSecret, facebook.appSecret, facebook.clearAppSecret),
      redirectUri: facebook.redirectUri !== undefined ? normalizeRedirect(facebook.redirectUri, 'Callback do Facebook') : trim(current.facebook?.redirectUri),
      graphVersion: facebook.graphVersion !== undefined ? limited(facebook.graphVersion, 'Versao da Facebook Graph API', 30) : trim(current.facebook?.graphVersion),
      scopes: facebook.scopes !== undefined ? limited(facebook.scopes, 'Scopes do Facebook', 1000) : trim(current.facebook?.scopes),
      pageId: facebook.pageId !== undefined ? limited(facebook.pageId, 'Facebook Page ID', 100) : trim(current.facebook?.pageId),
    },
    googleBusiness: {
      useYoutubeCredentials: typeof googleBusiness.useYoutubeCredentials === 'boolean'
        ? googleBusiness.useYoutubeCredentials
        : (current.googleBusiness?.useYoutubeCredentials ?? true),
      clientId: googleBusiness.clientId !== undefined ? limited(googleBusiness.clientId, 'Google Business Client ID') : trim(current.googleBusiness?.clientId),
      clientSecret: updateSecret(current.googleBusiness?.clientSecret, googleBusiness.clientSecret, googleBusiness.clearClientSecret),
      redirectUri: googleBusiness.redirectUri !== undefined ? normalizeRedirect(googleBusiness.redirectUri, 'Callback do Perfil da Empresa') : trim(current.googleBusiness?.redirectUri),
      locationName: googleBusiness.locationName !== undefined ? limited(googleBusiness.locationName, 'Location do Perfil da Empresa', 200) : trim(current.googleBusiness?.locationName),
      accountName: googleBusiness.accountName !== undefined ? limited(googleBusiness.accountName, 'Account do Perfil da Empresa', 200) : trim(current.googleBusiness?.accountName),
    },
  };

  if (next.instagram.graphVersion && !/^v\d+\.\d+$/.test(next.instagram.graphVersion)) {
    throw new Error('Versao da Instagram Graph API deve seguir o formato v26.0');
  }
  if (next.facebook.graphVersion && !/^v\d+\.\d+$/.test(next.facebook.graphVersion)) {
    throw new Error('Versao da Facebook Graph API deve seguir o formato v26.0');
  }
  if (next.linkedin.version && !/^\d{6}$/.test(next.linkedin.version)) {
    throw new Error('Versao do LinkedIn deve seguir o formato YYYYMM, por exemplo 202609');
  }

  saveAppSettings(next);
  return getSafeSettings();
}
