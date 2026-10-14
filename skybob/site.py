"""Bounded collection of public company pages, independent of AI web search."""
from __future__ import annotations

import gzip
import http.client
import io
import ipaddress
import json
import re
import socket
import time
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

MAX_BYTES = 2 * 1024 * 1024
MAX_TEXT = 14000
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Skybob/1.1"
)


def normalize_url(value: str) -> str:
    value = str(value or "").strip()
    if not value or re.search(r"[\s\x00-\x1f\\]", value):
        return ""
    if "://" not in value:
        value = "https://" + value
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return ""
        if parsed.username is not None or parsed.password is not None:
            return ""
        if parsed.port not in {None, 80, 443}:
            return ""
        hostname = parsed.hostname.encode("idna").decode("ascii").lower()
        host = f"[{hostname}]" if ":" in hostname else hostname
        port = f":{parsed.port}" if parsed.port else ""
        return urllib.parse.urlunsplit((parsed.scheme, host + port, parsed.path or "/", parsed.query, ""))[:2000]
    except (ValueError, UnicodeError):
        return ""


def _public_addresses(host: str, port: int) -> list[str]:
    addresses = list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(value).is_global for value in addresses):
        raise ValueError("O coletor aceita somente endereços públicos.")
    return addresses


def _validate_proxy_target(url: str):
    parsed = urllib.parse.urlsplit(normalize_url(url))
    host = parsed.hostname or ""
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("O coletor aceita somente endereços públicos.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            raise ValueError("O coletor aceita somente endereços públicos.")
        try:
            _public_addresses(host, parsed.port or (443 if parsed.scheme == "https" else 80))
        except socket.gaierror:
            # An explicitly configured egress proxy can own DNS resolution.
            # Literal IPs and known local hostnames are still rejected here.
            pass
    else:
        if not address.is_global:
            raise ValueError("O coletor aceita somente endereços públicos.")


def _read_response(response, url: str) -> dict:
    raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("A página excedeu o limite de coleta.")
    if response.getheader("Content-Encoding", "").lower() == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
            raw = compressed.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("A página excedeu o limite de coleta.")
    content_type = response.getheader("Content-Type", "")
    charset = re.search(r"charset\s*=\s*[\"']?([\w-]+)", content_type, re.I)
    if not charset:
        charset = re.search(rb"charset\s*=\s*[\"']?([\w-]+)", raw[:4096], re.I)
    encoding = charset.group(1) if charset else "utf-8"
    if isinstance(encoding, bytes):
        encoding = encoding.decode("ascii", "ignore")
    try:
        html = raw.decode(encoding, "replace")
    except LookupError:
        html = raw.decode("utf-8", "replace")
    return {"url": url, "httpStatus": response.status, "contentType": content_type, "html": html}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _proxy_request(url: str, timeout: float, proxies: dict) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies), _NoRedirect())
    deadline = time.monotonic() + timeout
    for _ in range(6):
        url = normalize_url(url)
        _validate_proxy_target(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("A consulta ao site excedeu o tempo disponível.")
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.7",
            "Accept-Language": "pt-BR,pt-PT;q=0.9,en;q=0.7", "Accept-Encoding": "gzip",
        })
        try:
            response = opener.open(request, timeout=remaining)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            if response.status in {301, 302, 303, 307, 308} and response.getheader("Location"):
                url = urllib.parse.urljoin(url, response.getheader("Location"))
                continue
            return _read_response(response, url)
    raise ValueError("O site redirecionou vezes demais.")


def _request(url: str, timeout: float) -> dict:
    """Validate every redirect and pin the connection to a validated public IP."""
    proxies = urllib.request.getproxies()
    if proxies.get(urllib.parse.urlsplit(url).scheme) and not urllib.request.proxy_bypass(urllib.parse.urlsplit(url).hostname):
        return _proxy_request(url, timeout, proxies)
    deadline = time.monotonic() + timeout
    for _ in range(6):
        url = normalize_url(url)
        if not url:
            raise ValueError("Endereço inválido para a coleta.")
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = _public_addresses(parsed.hostname, port)
        cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("A consulta ao site excedeu o tempo disponível.")
        connection = cls(parsed.hostname, port=port, timeout=remaining)

        def connect_public(_address, timeout=remaining, source_address=None):
            last_error = None
            for address in addresses:
                try:
                    return socket.create_connection((address, port), timeout, source_address)
                except OSError as exc:
                    last_error = exc
            raise last_error or OSError("Não foi possível conectar ao site.")

        connection._create_connection = connect_public
        try:
            path = urllib.parse.quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if parsed.query:
                path += "?" + urllib.parse.quote(parsed.query, safe="%=&?/:@!$'()*+,;~-._")
            connection.request("GET", path, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.7",
                "Accept-Language": "pt-BR,pt-PT;q=0.9,en;q=0.7",
                "Accept-Encoding": "gzip",
                "Connection": "close",
            })
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308} and response.getheader("Location"):
                url = urllib.parse.urljoin(url, response.getheader("Location"))
                continue
            return _read_response(response, url)
        finally:
            connection.close()
    raise ValueError("O site redirecionou vezes demais.")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.title_parts, self.schemas = [], [], [], []
        self.ignore = []
        self.in_title = False
        self.script = None
        self.script_parts = []
        self.description = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "style", "noscript", "svg", "template"}:
            self.ignore.append(tag)
            if tag == "script":
                self.script = attrs.get("type", "") == "application/ld+json"
                self.script_parts = []
        if tag == "title":
            self.in_title = True
        if tag == "meta" and attrs.get("name", "").lower() == "description":
            self.description = attrs.get("content", "")[:600]
        if tag == "a" and not self.ignore and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "section", "footer"} and not self.ignore:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "script" and self.script:
            try:
                self.schemas.append(json.loads("".join(self.script_parts)))
            except ValueError:
                pass
            self.script = None
        if tag in self.ignore:
            self.ignore = self.ignore[:self.ignore.index(tag)]
        if tag == "title":
            self.in_title = False
        if tag in {"p", "div", "li", "h1", "h2", "h3", "section"} and not self.ignore:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)
        elif self.ignore:
            if self.script:
                self.script_parts.append(data)
        else:
            self.parts.append(data + " ")


def _parse_page(response: dict, method: str = "http") -> dict:
    parser = PageParser()
    parser.feed(response.get("html", ""))
    lines = [re.sub(r"\s+", " ", line).strip() for line in "".join(parser.parts).splitlines()]
    text = "\n".join(dict.fromkeys(line for line in lines if line))
    return {
        "url": response["url"], "httpStatus": response.get("httpStatus", 200),
        "title": " ".join(parser.title_parts).strip()[:300], "description": parser.description,
        "text": text[:MAX_TEXT], "truncated": len(text) > MAX_TEXT,
        "structuredData": parser.schemas[:4], "links": parser.links[:150], "method": method,
    }


def _challenge(page: dict) -> bool:
    value = (page.get("title", "") + " " + page.get("text", "")[:700]).casefold()
    return any(term in value for term in (
        "just a moment", "verify you are human", "verifique que você é humano",
        "checking your browser", "access denied", "attention required!", "security verification",
    ))


def _render_page(url: str, timeout: float) -> dict | None:
    """Optional ordinary Chromium rendering for public JavaScript pages."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context = browser.new_context(user_agent=USER_AGENT, locale="pt-BR", service_workers="block")

                def route_request(route):
                    try:
                        parsed = urllib.parse.urlsplit(route.request.url)
                        if parsed.scheme not in {"http", "https"} or parsed.port not in {None, 80, 443}:
                            route.abort()
                            return
                        _public_addresses(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
                        if route.request.resource_type in {"image", "media", "font"}:
                            route.abort()
                        else:
                            route.continue_()
                    except (ValueError, OSError):
                        route.abort()

                context.route("**/*", route_request)
                page = context.new_page()
                response = page.goto(url, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                if response is None or response.status >= 400:
                    return None
                try:
                    page.wait_for_function("document.body && document.body.innerText.trim().length > 250", timeout=4000)
                except Exception:
                    pass
                html = page.content()
                if len(html.encode("utf-8")) > MAX_BYTES:
                    return None
                result = _parse_page({"url": page.url, "httpStatus": response.status, "html": html}, "browser")
                return None if _challenge(result) else result
            finally:
                browser.close()
    except Exception:
        # Missing Chromium or a rendering failure never interrupts the investigation.
        return None


def collect_site(url: str, *, max_pages: int = 4, timeout: float = 12, max_seconds: float = 55) -> dict:
    normalized = normalize_url(url)
    result = {
        "status": "unavailable", "requestedUrl": normalized or str(url), "pages": [], "attempts": [],
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "message": "",
    }
    if not normalized:
        result["message"] = "O endereço informado não é válido para coleta."
        return result
    start = time.monotonic()
    parsed = urllib.parse.urlsplit(normalized)
    queue = [normalized]
    root_host = parsed.hostname.removeprefix("www.")
    # Only the common www alias is tried, never a guessed unrelated company domain.
    if not re.fullmatch(r"[\d.:]+", root_host) and root_host.count(".") <= 2:
        alias = root_host if parsed.hostname.startswith("www.") else "www." + root_host
        queue.append(urllib.parse.urlunsplit((parsed.scheme, alias, parsed.path, parsed.query, "")))
    visited = set()
    while queue and len(result["pages"]) < max_pages and len(visited) < 7:
        remaining = max_seconds - (time.monotonic() - start)
        if remaining <= 1:
            break
        target = queue.pop(0)
        if target in visited:
            continue
        visited.add(target)
        try:
            response = _request(target, min(timeout, remaining))
            attempt = {"url": target, "httpStatus": response["httpStatus"], "finalUrl": response["url"]}
            result["attempts"].append(attempt)
            if response["httpStatus"] >= 400:
                continue
            if response["contentType"] and not any(kind in response["contentType"].lower() for kind in ("html", "text/plain")):
                attempt["error"] = "Formato não textual."
                continue
            page = _parse_page(response)
            if _challenge(page):
                attempt["error"] = "O site apresentou uma verificação de acesso."
                continue
            if len(page["text"]) < 250:
                rendered = _render_page(response["url"], min(timeout, max(1, max_seconds - (time.monotonic() - start))))
                if rendered and len(rendered["text"]) > len(page["text"]):
                    page = rendered
            if len(page["text"]) < 120:
                attempt["error"] = "A página retornou pouco conteúdo legível; pode depender de JavaScript."
                continue
            if any(existing["url"] == page["url"] for existing in result["pages"]):
                continue
            links = page.pop("links", [])
            result["pages"].append(page)
            base = urllib.parse.urlsplit(page["url"])
            relevant = []
            for link in links:
                candidate = normalize_url(urllib.parse.urljoin(page["url"], link))
                if not candidate:
                    continue
                part = urllib.parse.urlsplit(candidate)
                if part.hostname.removeprefix("www.") != base.hostname.removeprefix("www."):
                    continue
                if re.search(r"(?:sobre|about|empresa|quem-somos|contat|contact|servic|politic|privacy|termos|catalog)", urllib.parse.unquote(part.path), re.I):
                    if not re.search(r"\.(pdf|zip|png|jpe?g|mp4)$", part.path, re.I):
                        relevant.append(candidate)
            # Once content was read, prioritize actual internal links over an alias retry.
            queue = list(dict.fromkeys(relevant + queue))
        except (OSError, ValueError, EOFError, http.client.HTTPException) as exc:
            result["attempts"].append({"url": target, "error": str(exc)[:250]})
    if result["pages"]:
        result["status"] = "readable"
        result["message"] = f"Conteúdo do site consultado em {len(result['pages'])} página(s)."
    elif any(item.get("httpStatus") in {401, 403, 429} or "verificação" in item.get("error", "") for item in result["attempts"]):
        result["status"] = "blocked"
        result["message"] = "O site restringiu a coleta automática. Isso não comprova indisponibilidade para clientes."
    else:
        result["message"] = "Não foi possível ler o site nesta coleta. A investigação continua com fontes públicas e conteúdo indexado."
    return result


def research_context(collection: dict) -> dict:
    pages = []
    budget = 26000
    for page in collection.get("pages", []):
        text = page.get("text", "")[:min(10000, budget)]
        budget -= len(text)
        pages.append({
            "url": page["url"], "title": page.get("title", ""), "description": page.get("description", ""),
            "text": text, "excerptOnly": bool(page.get("truncated")) or len(text) < len(page.get("text", "")),
            "structuredData": json.dumps(page.get("structuredData", []), ensure_ascii=False)[:2000],
        })
        if budget <= 0:
            break
    return {"status": collection.get("status"), "message": collection.get("message"), "pages": pages}
