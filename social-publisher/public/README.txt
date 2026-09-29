SOCIAL PUBLISHER v0.5.1 - MODULO DO WORKSPACE

ACESSO
1. Entre normalmente no Workspace.
2. Para uso diario, use o acesso "Social Publisher — Operador".
3. Para configurar APIs, URLs e diagnostico, use "Social Publisher — Administrador".
4. O Workspace abre o modulo automaticamente em tela cheia.
5. O Operador publica, consulta historico e gerencia contas conectadas; credenciais tecnicas ficam restritas ao Administrador.
6. Desative o Modo Demo somente quando estiver pronto para publicar de verdade.

REDES
- YouTube: video via YouTube Data API.
- Instagram: imagem/Reel via Instagram Login direto.
- LinkedIn: texto/imagem/video.
- TikTok: foto/video via Content Posting API. OAuth web exige HTTPS; foto exige dominio/prefixo verificado.
- Facebook: Pagina administrada; texto, foto e Reel.
- Google Meu Negocio: Local Posts de texto/foto. O projeto Google precisa ser aprovado para Business Profile APIs.

CALLBACKS
A area Administracao > Diagnostico mostra as URLs corretas do Workspace. Elas seguem este formato:
<URL_PUBLICA_DO_WORKSPACE>/social/auth/youtube/callback
<URL_PUBLICA_DO_WORKSPACE>/social/auth/instagram/callback
<URL_PUBLICA_DO_WORKSPACE>/social/auth/linkedin/callback
<URL_PUBLICA_DO_WORKSPACE>/social/auth/tiktok/callback
<URL_PUBLICA_DO_WORKSPACE>/social/auth/facebook/callback
<URL_PUBLICA_DO_WORKSPACE>/social/auth/google-business/callback

IMPORTANTE
- O start.sh do Workspace inicia FastAPI e Social Publisher juntos.
- O Social Publisher usa a mesma chave JWT do Workspace para validar a conta.
- /social/uploads permanece publico por necessidade das APIs que buscam a midia por URL. Os nomes dos arquivos sao aleatorios e os uploads temporarios sao limpos.
- Para TikTok foto, a URL de midia precisa estar sob um dominio/prefixo verificado no TikTok Developers.


PAGINA PUBLICA
- /social/about apresenta a finalidade do aplicativo sem exigir login.
- /social/terms e /social/privacy permanecem publicas para revisao das plataformas.
