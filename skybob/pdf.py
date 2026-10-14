from __future__ import annotations

import io
import os
import re
from datetime import datetime
from urllib.parse import urlparse
from xml.sax.saxutils import escape

try:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import BaseDocTemplate, CondPageBreak, Flowable, Frame, PageTemplate, Paragraph, Table, TableStyle
except ImportError as exc:
    raise RuntimeError("O Skybob precisa do pacote reportlab. Rode: pip install -r requirements-skybob.txt") from exc

PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#0B1423")
INK = colors.HexColor("#13233A")
MUTED = colors.HexColor("#6B788A")
LINE = colors.HexColor("#E1E7EF")
PAPER = colors.HexColor("#F6F8FB")
WHITE = colors.white
RED = colors.HexColor("#E14F42")


def _register_fonts():
    directory = "/usr/share/fonts/truetype/dejavu"
    if os.path.exists(directory + "/DejaVuSans.ttf"):
        try:
            pdfmetrics.registerFont(TTFont("SkySans", directory + "/DejaVuSans.ttf"))
            pdfmetrics.registerFont(TTFont("SkySans-Bold", directory + "/DejaVuSans-Bold.ttf"))
            pdfmetrics.registerFontFamily("SkySans", normal="SkySans", bold="SkySans-Bold", italic="SkySans", boldItalic="SkySans-Bold")
            return "SkySans", "SkySans-Bold"
        except Exception:
            pass
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = _register_fonts()


def _clean(value):
    return str(value or "").strip().replace("—", "-").replace("–", "-").replace("…", "...")


def _text(value):
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", _clean(value))
    return escape(value).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br/>")


def _host(url):
    try:
        return (urlparse(url).hostname or url).removeprefix("www.")
    except ValueError:
        return url


def _style(name, **options):
    return ParagraphStyle(name, fontName=FONT, fontSize=9, leading=13, textColor=INK,
                          splitLongWords=True, allowWidows=0, allowOrphans=0, **options)


def _styles():
    return {
        "body": _style("body", spaceAfter=3 * mm),
        "lead": ParagraphStyle("lead", fontName=FONT, fontSize=11, leading=16, textColor=INK, spaceAfter=4 * mm, allowWidows=0, allowOrphans=0),
        "h2": ParagraphStyle("h2", fontName=FONT_BOLD, fontSize=12, leading=16, textColor=INK, spaceBefore=4 * mm, spaceAfter=3 * mm, keepWithNext=True),
        "small": ParagraphStyle("small", fontName=FONT, fontSize=7, leading=10, textColor=MUTED, spaceAfter=2.5 * mm, splitLongWords=True),
        "quote": _style("quote", leftIndent=4 * mm, rightIndent=4 * mm, spaceAfter=3 * mm),
        "bullet": _style("bullet", leftIndent=4 * mm, firstLineIndent=-4 * mm, spaceAfter=2.5 * mm),
    }


class SectionBand(Flowable):
    keepWithNext = False

    def __init__(self, number, title, subtitle=""):
        super().__init__()
        self.number, self.title, self.subtitle = number, title, subtitle
        self.spaceBefore = 6 * mm
        self.spaceAfter = 4 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        self._title = Paragraph(_text(self.title), ParagraphStyle("band-title", fontName=FONT_BOLD, fontSize=13, leading=17, textColor=WHITE))
        self._subtitle = Paragraph(_text(self.subtitle), ParagraphStyle("band-subtitle", fontName=FONT, fontSize=7.5, leading=11, textColor=colors.HexColor("#AAB8CB")))
        self._title_h = self._title.wrap(availWidth - 29 * mm, availHeight)[1]
        self._subtitle_h = self._subtitle.wrap(availWidth - 29 * mm, availHeight)[1] if self.subtitle else 0
        self.height = 12 * mm + self._title_h + (3 * mm + self._subtitle_h if self.subtitle else 0)
        return availWidth, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(NAVY)
        c.roundRect(0, 0, self.width, self.height, 3 * mm, fill=1, stroke=0)
        c.setFillColor(RED)
        c.setFont(FONT_BOLD, 10)
        c.drawString(6 * mm, self.height - 6 * mm - 12, self.number)
        y = self.height - 6 * mm - self._title_h
        self._title.drawOn(c, 22 * mm, y)
        if self.subtitle:
            self._subtitle.drawOn(c, 22 * mm, y - 3 * mm - self._subtitle_h)


class MetricStrip(Flowable):
    def __init__(self, items):
        super().__init__()
        self.items = items
        self.spaceAfter = 4 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        cell = availWidth / max(1, len(self.items))
        self.labels = [Paragraph(_text(label), ParagraphStyle("metric-label", fontName=FONT, fontSize=7, leading=10, textColor=MUTED, alignment=TA_CENTER)) for _, label in self.items]
        self.label_heights = [p.wrap(cell - 6 * mm, availHeight)[1] for p in self.labels]
        self.height = 18 * mm + max(self.label_heights, default=0)
        return availWidth, self.height

    def draw(self):
        c = self.canv
        cell = self.width / max(1, len(self.items))
        c.setFillColor(WHITE)
        c.roundRect(0, 0, self.width, self.height, 3 * mm, fill=1, stroke=0)
        for index, (value, _) in enumerate(self.items):
            x = index * cell
            if index:
                c.setStrokeColor(LINE)
                c.line(x, 4 * mm, x, self.height - 4 * mm)
            label = _clean(value)
            size = min(19, (cell - 6 * mm) / max(1, pdfmetrics.stringWidth(label, FONT_BOLD, 1)))
            c.setFillColor(INK)
            c.setFont(FONT_BOLD, size)
            c.drawCentredString(x + cell / 2, self.height - 10 * mm, label)
            self.labels[index].drawOn(c, x + 3 * mm, 4 * mm)


class FindingCard(Flowable):
    """Measured heading and body; long text continues inside another measured card."""
    def __init__(self, title, body, badge, refs="", body_paragraph=None, continuation=False):
        super().__init__()
        self.title, self.body, self.badge, self.refs = map(_clean, (title, body, badge, refs))
        self.continuation = continuation
        self._body = body_paragraph
        self.spaceAfter = 3 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        inner = availWidth - 12 * mm
        heading = self.title + (" (continuação)" if self.continuation else "")
        self._heading = Paragraph(_text(heading), ParagraphStyle("finding-title", fontName=FONT_BOLD, fontSize=11, leading=15, textColor=INK))
        self._badge = Paragraph(_text(self.badge.upper()), ParagraphStyle("finding-badge", fontName=FONT_BOLD, fontSize=6.5, leading=9, textColor=RED))
        self._refs = Paragraph(_text(self.refs), ParagraphStyle("finding-refs", fontName=FONT, fontSize=6.5, leading=9, textColor=MUTED))
        if self._body is None:
            self._body = Paragraph(_text(self.body), _style("finding-body"))
        self._heading_h = self._heading.wrap(inner, availHeight)[1]
        self._badge_h = self._badge.wrap(inner, availHeight)[1]
        self._refs_h = self._refs.wrap(inner, availHeight)[1] if self.refs else 0
        self._body_h = self._body.wrap(inner, availHeight)[1]
        self._overhead = 12 * mm + self._badge_h + 2 * mm + self._heading_h + 2.5 * mm
        if self.refs:
            self._overhead += 3 * mm + self._refs_h
        self.height = self._overhead + self._body_h
        return availWidth, self.height

    def split(self, availWidth, availHeight):
        self.wrap(availWidth, availHeight)
        # References belong only to the last fragment, making room for actual text.
        first_overhead = self._overhead - (3 * mm + self._refs_h if self.refs else 0)
        available_body = availHeight - first_overhead
        if available_body < 26:
            return []
        parts = self._body.split(availWidth - 12 * mm, available_body)
        if len(parts) < 2:
            return []
        return [
            FindingCard(self.title, "", self.badge, "", parts[0], self.continuation),
            FindingCard(self.title, "", self.badge, self.refs, parts[1], True),
        ]

    def draw(self):
        c = self.canv
        c.setFillColor(WHITE)
        c.setStrokeColor(LINE)
        c.roundRect(0, 0, self.width, self.height, 3 * mm, fill=1, stroke=1)
        c.setFillColor(RED)
        c.roundRect(0, 5 * mm, 1 * mm, self.height - 10 * mm, .5 * mm, fill=1, stroke=0)
        y = self.height - 6 * mm
        for paragraph, height, gap in ((self._badge, self._badge_h, 2 * mm), (self._heading, self._heading_h, 2.5 * mm), (self._body, self._body_h, 3 * mm)):
            y -= height
            paragraph.drawOn(c, 6 * mm, y)
            y -= gap
        if self.refs:
            y -= self._refs_h
            self._refs.drawOn(c, 6 * mm, y)


class LockedPlan(Flowable):
    def __init__(self, priorities, fronts):
        super().__init__()
        self.priorities, self.fronts = priorities, fronts
        self.rows = min(4, priorities)
        self.height = (49 + self.rows * 8) * mm
        self.spaceAfter = 5 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(NAVY)
        c.roundRect(0, 0, self.width, self.height, 4 * mm, fill=1, stroke=0)
        c.setFillColor(colors.HexColor("#AAB8CB"))
        c.setFont(FONT_BOLD, 8)
        c.drawString(7 * mm, self.height - 10 * mm, "ESTRATÉGIA DE CORREÇÃO IDENTIFICADA")
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, 19)
        c.drawString(7 * mm, self.height - 21 * mm, f"{self.priorities} prioridades. {self.fronts} frentes.")
        c.setFillColor(colors.HexColor("#AAB8CB"))
        c.setFont(FONT, 8)
        c.drawString(7 * mm, self.height - 28 * mm, "Os próximos passos não fazem parte desta auditoria.")
        for index in range(self.rows):
            y = self.height - (40 + index * 8) * mm
            c.setFillColor(colors.HexColor("#253247"))
            c.roundRect(7 * mm, y, self.width - 14 * mm, 6 * mm, 1.5 * mm, fill=1, stroke=0)
            c.setFillColor(colors.HexColor("#647187"))
            c.roundRect(11 * mm, y + 3 * mm, (self.width - 30 * mm) * (0.66 if index % 2 else .8), 1.3 * mm, .6 * mm, fill=1, stroke=0)
        label, size = "CONTEÚDO BLOQUEADO", 7
        pill_width = pdfmetrics.stringWidth(label, FONT_BOLD, size) + 8 * mm
        x = self.width - 7 * mm - pill_width
        c.setFillColor(RED)
        c.roundRect(x, 6 * mm, pill_width, 8 * mm, 4 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, size)
        c.drawCentredString(x + pill_width / 2, 8.8 * mm, label)


def _source_index(payload):
    evidence = {item["id"]: item for item in payload.get("evidence", [])}
    report = payload.get("report") or {}
    used_ids = []
    for item in report.get("findings", []) + report.get("promise_matrix", []):
        used_ids.extend(item.get("evidence_ids", []))
    # Approved evidence also supports the narrative and social-proof paragraphs.
    used_ids.extend(item["id"] for item in evidence.values() if item.get("auditStatus") == "approved")
    urls = list(dict.fromkeys(url for key in used_ids for url in evidence.get(key, {}).get("sourceUrls", [])))
    return {url: index + 1 for index, url in enumerate(urls)}, urls, evidence


def _refs_for_ids(ids, evidence, numbers):
    refs = sorted({numbers[url] for key in ids or [] for url in evidence.get(key, {}).get("sourceUrls", []) if url in numbers})
    return "Fontes " + ", ".join(f"[{n}]" for n in refs) if refs else ""


def _page_chrome(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(RED)
    canvas.rect(0, PAGE_H - 3 * mm, PAGE_W, 3 * mm, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 14 * mm, PAGE_W - 18 * mm, 14 * mm)
    canvas.setFont(FONT, 6.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 8 * mm, "SKYBOB - DOSSIÊ DE AUTORIDADE DIGITAL")
    canvas.drawRightString(PAGE_W - 18 * mm, 8 * mm, str(doc.page))
    canvas.restoreState()


def render_dossier_pdf(payload: dict) -> bytes:
    report = payload.get("report") or {}
    if not report:
        raise ValueError("O dossiê comercial ainda não foi produzido.")
    styles, buffer = _styles(), io.BytesIO()
    doc = BaseDocTemplate(buffer, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                          topMargin=17 * mm, bottomMargin=21 * mm,
                          title=f"Dossiê Skybob - {payload.get('companyName', 'Empresa')}", author="Skybob")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="normal", frames=[frame], onPage=_page_chrome)])
    story = []
    numbers, urls, evidence = _source_index(payload)
    section_number = 0

    def section(title, subtitle="", min_next=28):
        nonlocal section_number
        section_number += 1
        band = SectionBand(f"{section_number:02d}", title, subtitle)
        band.wrap(doc.width, doc.height)
        # Reserve only the beginning of the next block, not its entire height.
        # keepWithNext would push a multi-page card/table to a fresh page.
        story.append(CondPageBreak(band.height + band.spaceBefore + band.spaceAfter + min_next))
        story.append(band)

    def paragraph(value, style="body"):
        if _clean(value):
            story.append(Paragraph(_text(value), styles[style]))

    def bullets(items):
        for value in dict.fromkeys(_clean(item) for item in items or [] if _clean(item)):
            story.append(Paragraph("• " + _text(value), styles["bullet"]))

    # The opening shares a page with the content instead of a mostly empty cover.
    story.append(Paragraph("SKYBOB", ParagraphStyle("brand", fontName=FONT_BOLD, fontSize=29, leading=33, textColor=RED, spaceAfter=2 * mm)))
    story.append(Paragraph("DOSSIÊ DE AUTORIDADE DIGITAL", styles["small"]))
    story.append(Paragraph(_text(payload.get("companyName") or "Empresa"), ParagraphStyle("company", fontName=FONT_BOLD, fontSize=25, leading=31, textColor=INK, spaceBefore=4 * mm, spaceAfter=2 * mm, keepWithNext=True)))
    paragraph(payload.get("city"), "small")
    paragraph(report.get("cover_line"), "lead")
    counts = payload.get("counts") or {}
    story.append(MetricStrip([(counts.get("sources", 0), "fontes públicas"), (counts.get("approved", 0), "evidências aprovadas"), (counts.get("discarded", 0), "sinais descartados"), (counts.get("searches", 0), "frentes pesquisadas")]))
    paragraph(report.get("opening"), "lead")
    if report.get("surface_strengths"):
        paragraph("O que fortalece a primeira impressão", "h2")
        bullets(report["surface_strengths"])

    findings = report.get("findings") or []
    first_minimum = 28
    if findings:
        first = FindingCard(findings[0].get("title", "Achado"), "", findings[0].get("category", "evidência"))
        first.wrap(doc.width, doc.height)
        first_minimum = first._overhead + 26
    section("O que a investigação conseguiu sustentar", "Achados aprovados pela auditoria, com referências às fontes.", first_minimum)
    if findings:
        for item in findings:
            story.append(FindingCard(item.get("title", "Achado"), item.get("body", ""), item.get("category", "evidência"), _refs_for_ids(item.get("evidence_ids"), evidence, numbers)))
    else:
        paragraph("Não foram confirmadas fragilidades suficientes para sustentar críticas fortes sem extrapolar as evidências.", "lead")

    quotes = [item for item in payload.get("evidence", []) if item.get("auditStatus") == "approved" and item.get("quote") and item.get("evidenceType") == "customer_report"][:4]
    if report.get("social_proof") or quotes:
        section("Prova social sob pressão", "Avaliações e depoimentos no contexto das evidências encontradas.")
        bullets(report.get("social_proof"))
        for item in quotes:
            refs = _refs_for_ids([item["id"]], evidence, numbers)
            story.append(Paragraph(f'“{_text(item["quote"])}”<br/><font size="7" color="#6B788A">{_text(refs)}</font>', styles["quote"]))

    matrix = report.get("promise_matrix") or []
    if matrix:
        section("Marketing é fácil. Evidência é mais difícil.", "O que a marca transmite e o que foi possível comprovar.", 80)
        widths = [doc.width * .29, doc.width * .54, doc.width * .17]
        header = ParagraphStyle("table-heading", fontName=FONT_BOLD, fontSize=7, leading=10, textColor=WHITE)
        cell = ParagraphStyle("table-cell", fontName=FONT, fontSize=8, leading=11.5, textColor=INK, splitLongWords=True)
        data = [[Paragraph(value, header) for value in ("O que a empresa transmite", "O que foi possível comprovar", "Estado")]]
        labels = {"supported": "Sustentado", "partially_supported": "Parcial", "not_verified": "Não verificado", "contradicted": "Contradição"}
        for item in matrix:
            refs = _refs_for_ids(item.get("evidence_ids"), evidence, numbers)
            text = _clean(item.get("evidence")) + ("\n" + refs if refs else "")
            data.append([Paragraph(_text(value), cell) for value in (item.get("claim"), text, labels.get(item.get("status"), item.get("status", "")))])
        table = Table(data, colWidths=widths, repeatRows=1, splitByRow=1, splitInRow=1, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("BACKGROUND", (0, 1), (-1, -1), WHITE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), .35, LINE),
            ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm), ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
            ("TOPPADDING", (0, 0), (-1, -1), 3 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
        ]))
        story.append(table)

    if report.get("authority_bullets") or report.get("ai_visibility_bullets"):
        section("Autoridade demonstrada e presença nas IAs", "A presença própria da marca e sua validação externa.")
        bullets(report.get("authority_bullets"))
        if report.get("ai_visibility_bullets"):
            paragraph("O que as evidências dizem sobre a visibilidade em IA", "h2")
            bullets(report["ai_visibility_bullets"])

    if report.get("synthesis_bullets"):
        section("O que fica documentado", "Síntese dos pontos sustentados pela investigação.")
        for index, value in enumerate(report["synthesis_bullets"], 1):
            story.append(Paragraph(f"<b>{index:02d}.</b> " + _text(value), styles["bullet"]))

    hidden = report.get("hidden_next_steps") or []
    minimum = LockedPlan(len(hidden), 0).height if hidden else 28
    section("O diagnóstico termina aqui", "A estratégia de correção é outra etapa.", minimum)
    if hidden:
        fronts = {item.get("front") for item in hidden if item.get("front")}
        story.append(LockedPlan(len(hidden), len(fronts)))
    paragraph(report.get("final_line") or "A investigação está documentada. A estratégia de correção não faz parte deste dossiê.", "lead")

    # Compact references remain in the document's natural flow, with clickable URLs.
    if urls:
        paragraph("Referências das evidências", "h2")
        for url in urls:
            parsed = urlparse(url)
            label = f"[{numbers[url]}] {_text(_host(url))}"
            href = escape(url, {'"': "&quot;"})
            link = f'<link href="{href}" color="#3974D8">{_text(url)}</link>' if parsed.scheme in {"http", "https"} else _text(url)
            story.append(Paragraph(f"<b>{label}</b><br/>{link}", styles["small"]))
    stamp = payload.get("completedAt") or ""
    try:
        date = datetime.fromisoformat(stamp).strftime("%d/%m/%Y")
    except ValueError:
        date = datetime.now().strftime("%d/%m/%Y")
    paragraph(f"Investigação concluída em {date}. Relatos e indícios permanecem identificados; limitações de acesso não demonstram irregularidades.", "small")
    doc.build(story)
    return buffer.getvalue()
