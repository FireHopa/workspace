from __future__ import annotations

import io
import os
import re
from datetime import datetime
from urllib.parse import urlparse
from xml.sax.saxutils import escape

try:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        BaseDocTemplate, Flowable, Frame, KeepTogether, PageBreak, PageTemplate,
        Paragraph, Spacer, Table, TableStyle,
    )
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
AMBER = colors.HexColor("#D99B32")
BLUE = colors.HexColor("#3974D8")
GREEN = colors.HexColor("#2F9B6A")


def _register_fonts():
    regular = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if os.path.exists(regular) and os.path.exists(bold):
        try:
            pdfmetrics.registerFont(TTFont("SkySans", regular))
            pdfmetrics.registerFont(TTFont("SkySans-Bold", bold))
            return "SkySans", "SkySans-Bold"
        except Exception:
            pass
    return "Helvetica", "Helvetica-Bold"

FONT, FONT_BOLD = _register_fonts()


def _clean(value) -> str:
    text = str(value or "").strip()
    text = text.replace("—", "-").replace("–", "-").replace("…", "...")
    return text


def _text(value) -> str:
    """Treat generated research as plain text, never as ReportLab markup."""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", _clean(value))
    return escape(text).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br/>")


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or url).removeprefix("www.")
    except ValueError:
        return url


class SectionBand(Flowable):
    def __init__(self, number: str, title: str, subtitle: str = ""):
        super().__init__()
        self.number = number
        self.title = title
        self.subtitle = subtitle
        self.height = 28 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        c = self.canv
        w = self.width
        c.setFillColor(NAVY)
        c.roundRect(0, 0, w, self.height, 4 * mm, fill=1, stroke=0)
        c.setFillColor(RED)
        c.setFont(FONT_BOLD, 10)
        c.drawString(7 * mm, self.height - 10 * mm, self.number)
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, 16)
        c.drawString(22 * mm, self.height - 10.5 * mm, self.title[:80])
        if self.subtitle:
            c.setFillColor(colors.HexColor("#AAB8CB"))
            c.setFont(FONT, 8)
            c.drawString(22 * mm, 6.5 * mm, self.subtitle[:120])


class MetricStrip(Flowable):
    def __init__(self, items):
        super().__init__()
        self.items = items
        self.height = 31 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        c = self.canv
        n = max(1, len(self.items))
        cell = self.width / n
        for i, (value, label) in enumerate(self.items):
            x = i * cell
            if i:
                c.setStrokeColor(LINE)
                c.line(x, 3 * mm, x, self.height - 3 * mm)
            c.setFillColor(INK)
            c.setFont(FONT_BOLD, 19)
            c.drawCentredString(x + cell / 2, 16 * mm, _clean(value)[:20])
            c.setFillColor(MUTED)
            c.setFont(FONT, 7.5)
            c.drawCentredString(x + cell / 2, 8 * mm, _clean(label)[:42])


class LockedPlan(Flowable):
    def __init__(self, priorities: int, fronts: int):
        super().__init__()
        self.priorities = priorities
        self.fronts = fronts
        self.height = 108 * mm

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        c = self.canv
        w = self.width
        c.setFillColor(NAVY)
        c.roundRect(0, 0, w, self.height, 5 * mm, fill=1, stroke=0)
        c.setFillColor(colors.HexColor("#73839A"))
        c.setFont(FONT_BOLD, 8)
        c.drawString(8 * mm, self.height - 12 * mm, "PLANO DE CORRECAO IDENTIFICADO")
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, 22)
        c.drawString(8 * mm, self.height - 25 * mm, f"{self.priorities} prioridades. {self.fronts} frentes.")
        c.setFillColor(colors.HexColor("#B1BECE"))
        c.setFont(FONT, 8)
        c.drawString(8 * mm, self.height - 34 * mm, "Os proximos passos existem, mas nao fazem parte desta auditoria.")
        top = self.height - 48 * mm
        for i in range(min(6, max(3, self.priorities))):
            y = top - i * 10.8 * mm
            c.setFillColor(colors.HexColor("#253247"))
            c.roundRect(8 * mm, y, w - 16 * mm, 7.5 * mm, 2 * mm, fill=1, stroke=0)
            # varias faixas translúcidas dão sensação de conteúdo desfocado/bloqueado
            widths = [0.77, 0.58, 0.69]
            c.setFillColor(colors.Color(0.72, 0.76, 0.82, alpha=0.32))
            c.roundRect(12 * mm, y + 4.3 * mm, (w - 32 * mm) * widths[i % 3], 1.7 * mm, 0.8 * mm, fill=1, stroke=0)
            c.setFillColor(colors.Color(0.72, 0.76, 0.82, alpha=0.20))
            c.roundRect(12 * mm, y + 1.7 * mm, (w - 42 * mm) * widths[(i + 1) % 3], 1.2 * mm, 0.6 * mm, fill=1, stroke=0)
        c.setFillColor(RED)
        c.roundRect(w - 40 * mm, 8 * mm, 30 * mm, 9 * mm, 4.5 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, 7.3)
        c.drawCentredString(w - 25 * mm, 11.3 * mm, "CONTEUDO BLOQUEADO")


class FindingCard(Flowable):
    def __init__(self, title: str, body: str, badge: str, refs: str, body_paragraph=None, continuation=False):
        super().__init__()
        self.title = _clean(title)
        self.body = _clean(body)
        self.badge = _clean(badge)
        self.refs = _clean(refs)
        self.continuation = continuation
        self.width = 0
        self.height = 0
        self._body_para = body_paragraph

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        if self._body_para is None:
            style = ParagraphStyle("finding-body-inner", fontName=FONT, fontSize=9, leading=13, textColor=INK)
            self._body_para = Paragraph(_text(self.body), style)
        _, body_h = self._body_para.wrap(availWidth - 16 * mm, availHeight)
        # Reserve room for heading, body and footer without overlapping text.
        self.height = max(40 * mm, body_h + 34 * mm)
        return availWidth, self.height

    def split(self, availWidth, availHeight):
        # Custom Flowables cannot split automatically. Split paragraphs into
        # linked visual cards instead of failing on long generated reports.
        if availHeight <= 42 * mm:
            return []
        if self._body_para is None:
            self.wrap(availWidth, availHeight)
        parts = self._body_para.split(availWidth - 16 * mm, availHeight - 34 * mm)
        if len(parts) < 2:
            return []
        first = FindingCard(self.title, "", self.badge, "", body_paragraph=parts[0], continuation=self.continuation)
        rest = FindingCard(self.title, "", self.badge, self.refs, body_paragraph=parts[1], continuation=True)
        return [first, rest]

    def draw(self):
        c = self.canv
        c.setFillColor(WHITE)
        c.setStrokeColor(LINE)
        c.roundRect(0, 0, self.width, self.height, 4 * mm, fill=1, stroke=1)
        c.setFillColor(RED)
        c.roundRect(6 * mm, self.height - 12 * mm, 27 * mm, 6 * mm, 3 * mm, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont(FONT_BOLD, 6.5)
        c.drawCentredString(19.5 * mm, self.height - 9.9 * mm, self.badge[:24].upper())
        c.setFillColor(INK)
        c.setFont(FONT_BOLD, 13)
        heading = self.title + (" (cont.)" if self.continuation else "")
        c.drawString(7 * mm, self.height - 20 * mm, heading[:78])
        if self._body_para:
            self._body_para.drawOn(c, 7 * mm, 8 * mm)
        if self.refs:
            c.setFillColor(MUTED)
            c.setFont(FONT, 6.5)
            c.drawRightString(self.width - 7 * mm, 4 * mm, self.refs[:90])


def _styles():
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle("h1", parent=base["Heading1"], fontName=FONT_BOLD, fontSize=28, leading=31, textColor=INK, spaceAfter=8 * mm),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName=FONT_BOLD, fontSize=18, leading=22, textColor=INK, spaceBefore=2 * mm, spaceAfter=5 * mm),
        "body": ParagraphStyle("body", parent=base["BodyText"], fontName=FONT, fontSize=9.5, leading=14.2, textColor=INK, spaceAfter=4 * mm),
        "lead": ParagraphStyle("lead", parent=base["BodyText"], fontName=FONT, fontSize=13, leading=19, textColor=INK, spaceAfter=6 * mm),
        "small": ParagraphStyle("small", parent=base["BodyText"], fontName=FONT, fontSize=7.5, leading=10.5, textColor=MUTED, spaceAfter=2 * mm),
        "quote": ParagraphStyle("quote", parent=base["BodyText"], fontName=FONT, fontSize=10, leading=15, leftIndent=7 * mm, borderColor=LINE, borderWidth=0, borderPadding=0, textColor=INK, spaceAfter=4 * mm),
        "final": ParagraphStyle("final", parent=base["BodyText"], fontName=FONT_BOLD, fontSize=23, leading=28, alignment=TA_CENTER, textColor=INK, spaceBefore=18 * mm, spaceAfter=8 * mm),
        "center": ParagraphStyle("center", parent=base["BodyText"], fontName=FONT, fontSize=10, leading=15, alignment=TA_CENTER, textColor=MUTED),
    }


def _source_index(payload: dict):
    evidence_by_id = {item["id"]: item for item in payload.get("evidence", [])}
    report = payload.get("report") or {}
    used_ids = []
    for finding in report.get("findings", []):
        used_ids.extend(finding.get("evidence_ids", []))
    for row in report.get("promise_matrix", []):
        used_ids.extend(row.get("evidence_ids", []))
    urls = []
    for evidence_id in used_ids:
        item = evidence_by_id.get(evidence_id)
        if not item:
            continue
        for url in item.get("sourceUrls", []):
            if url not in urls:
                urls.append(url)
    return {url: index + 1 for index, url in enumerate(urls)}, urls, evidence_by_id


def _refs_for_ids(ids, evidence_by_id, source_numbers):
    refs = []
    for evidence_id in ids or []:
        item = evidence_by_id.get(evidence_id)
        if not item:
            continue
        for url in item.get("sourceUrls", []):
            if url in source_numbers:
                refs.append(source_numbers[url])
    refs = sorted(set(refs))
    return "Fontes " + ", ".join(f"[{n}]" for n in refs) if refs else ""


def _page_chrome(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 14 * mm, PAGE_W - 18 * mm, 14 * mm)
    canvas.setFont(FONT, 6.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 8 * mm, "SKYBOB - INVESTIGACAO DE AUTORIDADE DIGITAL")
    canvas.drawRightString(PAGE_W - 18 * mm, 8 * mm, str(doc.page))
    canvas.restoreState()


def render_dossier_pdf(payload: dict) -> bytes:
    report = payload.get("report") or {}
    if not report:
        raise ValueError("O dossiê comercial ainda não foi produzido.")
    styles = _styles()
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=20 * mm,
        title=f"Dossie Skybob - {payload.get('companyName','Empresa')}",
        author="Skybob",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="normal", frames=[frame], onPage=_page_chrome)])
    story = []
    source_numbers, source_urls, evidence_by_id = _source_index(payload)

    # capa
    story.append(Spacer(1, 22 * mm))
    story.append(Paragraph("SKYBOB", ParagraphStyle("cover-brand", fontName=FONT_BOLD, fontSize=42, leading=44, textColor=RED, spaceAfter=5 * mm)))
    story.append(Paragraph("DOSSIÊ DE AUTORIDADE DIGITAL", ParagraphStyle("cover-kicker", fontName=FONT_BOLD, fontSize=11, leading=14, textColor=MUTED, spaceAfter=17 * mm)))
    story.append(Paragraph(_text(payload.get("companyName")), ParagraphStyle("cover-company", fontName=FONT_BOLD, fontSize=30, leading=34, textColor=INK, spaceAfter=3 * mm)))
    story.append(Paragraph(_text(payload.get("city")), ParagraphStyle("cover-city", fontName=FONT, fontSize=12, leading=16, textColor=MUTED, spaceAfter=18 * mm)))
    story.append(Paragraph(_text(report.get("cover_line") or "O que a internet realmente consegue provar sobre sua empresa."), styles["lead"]))
    story.append(Spacer(1, 22 * mm))
    story.append(Paragraph("Investigada como um cliente, um concorrente e um sistema de IA investigariam: sem assumir que a narrativa da própria marca é verdadeira.", styles["small"]))
    story.append(PageBreak())

    # choque inicial
    story.append(SectionBand("01", "A primeira impressão não encerra a investigação", "Aparência profissional e autoridade comprovada são coisas diferentes."))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(_text(report.get("opening")), styles["lead"]))
    counts = payload.get("counts", {})
    story.append(MetricStrip([
        (str(counts.get("sources", 0)), "fontes públicas examinadas"),
        (str(counts.get("approved", 0)), "evidências aprovadas"),
        (str(counts.get("discarded", 0)), "sinais descartados ou rejeitados"),
        (str(counts.get("searches", 0)), "frentes de investigação"),
    ]))
    story.append(Spacer(1, 7 * mm))
    strengths = report.get("surface_strengths") or []
    if strengths:
        story.append(Paragraph("À primeira vista, há sinais que ajudam a empresa a parecer sólida.", styles["h2"]))
        for item in strengths[:6]:
            story.append(Paragraph("• " + _text(item), styles["body"]))
        story.append(Spacer(1, 5 * mm))
        story.append(Paragraph("O problema começa quando paramos de olhar a aparência e começamos a exigir evidência.", styles["h2"]))
    story.append(PageBreak())

    # achados
    story.append(SectionBand("02", "O que não resistiu bem à investigação", "Somente achados aprovados pela auditoria entram aqui."))
    story.append(Spacer(1, 7 * mm))
    findings = report.get("findings") or []
    if findings:
        for finding in findings[:8]:
            refs = _refs_for_ids(finding.get("evidence_ids"), evidence_by_id, source_numbers)
            story.append(FindingCard(finding.get("title", "Achado"), finding.get("body", ""), finding.get("category", "evidência"), refs))
            story.append(Spacer(1, 4 * mm))
    else:
        story.append(Paragraph("A investigação não encontrou fragilidades fortes o suficiente para sustentar um bloco comercial agressivo sem extrapolar as evidências.", styles["lead"]))
    story.append(PageBreak())

    # prova social
    story.append(SectionBand("03", "Prova social sob pressão", "Nota alta, seguidores e depoimentos não encerram a análise."))
    story.append(Spacer(1, 8 * mm))
    social = report.get("social_proof") or []
    if social:
        for item in social[:8]:
            story.append(Paragraph("• " + _text(item), styles["body"]))
    else:
        story.append(Paragraph("Não houve material auditado suficiente para fazer afirmações fortes sobre a prova social sem especulação.", styles["body"]))
    quotes = [item for item in payload.get("evidence", []) if item.get("auditStatus") == "approved" and item.get("quote")]
    if quotes:
        story.append(Spacer(1, 5 * mm))
        story.append(Paragraph("Quando a empresa perde o controle da conversa", styles["h2"]))
        for item in quotes[:4]:
            refs = _refs_for_ids([item["id"]], evidence_by_id, source_numbers)
            story.append(Paragraph(f'“{_text(item.get("quote"))}” <font size="7" color="#6B788A">{refs}</font>', styles["quote"]))
    story.append(PageBreak())

    # promessa x evidência
    story.append(SectionBand("04", "Marketing é fácil. Evidência é mais difícil.", "O que a marca transmite versus o que foi possível sustentar."))
    story.append(Spacer(1, 7 * mm))
    matrix = report.get("promise_matrix") or []
    if matrix:
        data = [["O que a empresa transmite", "O que foi possível comprovar", "Estado"]]
        status_labels = {"supported": "Sustentado", "partially_supported": "Parcial", "not_verified": "Não verificado", "contradicted": "Contradição"}
        sections = []
        for row in matrix[:8]:
            refs = _refs_for_ids(row.get("evidence_ids"), evidence_by_id, source_numbers)
            evidence_text = _clean(row.get("evidence")) + (f"\n{refs}" if refs else "")
            claim = Paragraph(_text(row.get("claim")), styles["small"])
            evidence = Paragraph(_text(evidence_text), styles["small"])
            status = Paragraph(_text(status_labels.get(row.get("status"), _clean(row.get("status")))), styles["small"])
            paragraphs = [claim, evidence, status]
            cell_widths = [55 * mm, 88 * mm, 29 * mm]
            tallest = max(p.wrap(w - 6 * mm, doc.height)[1] for p, w in zip(paragraphs, cell_widths))
            # A ReportLab Table cannot split a single oversized row.
            if tallest + 10 * mm > doc.height - 25 * mm:
                if len(data) > 1:
                    sections.append(("table", data))
                    data = [data[0]]
                sections.append(("long", paragraphs))
            else:
                data.append(paragraphs)
        if len(data) > 1:
            sections.append(("table", data))
        for kind, value in sections:
            if kind == "long":
                # Plain paragraphs can continue across pages safely.
                story.append(Paragraph(data[0][0], styles["h2"]))
                story.append(value[0])
                story.append(Spacer(1, 3 * mm))
                story.append(Paragraph(data[0][1], styles["h2"]))
                story.append(value[1])
                story.append(Spacer(1, 2 * mm))
                story.append(value[2])
                story.append(Spacer(1, 5 * mm))
                continue
            table = Table(value, colWidths=[55 * mm, 88 * mm, 29 * mm], repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD), ("FONTSIZE", (0, 0), (-1, 0), 7.5),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm), ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm), ("GRID", (0, 0), (-1, -1), .35, LINE),
                ("BACKGROUND", (0, 1), (-1, -1), WHITE),
            ]))
            story.append(table)
    else:
        story.append(Paragraph("Não foi possível construir uma matriz promessa x evidência sem inventar alegações ou extrapolar fontes.", styles["body"]))
    story.append(PageBreak())

    # autoridade + IA
    story.append(SectionBand("05", "Autoridade não é declarada. É demonstrada.", "A presença própria da marca não substitui validação independente."))
    story.append(Spacer(1, 8 * mm))
    for item in (report.get("authority_bullets") or [])[:8]:
        story.append(Paragraph("• " + _text(item), styles["body"]))
    story.append(Spacer(1, 7 * mm))
    story.append(Paragraph("Uma IA não conhece sua empresa porque você diz que ela é boa.", styles["h2"]))
    for item in (report.get("ai_visibility_bullets") or [])[:8]:
        story.append(Paragraph("• " + _text(item), styles["body"]))
    story.append(PageBreak())

    # síntese
    story.append(SectionBand("06", "Onde a credibilidade fica vulnerável", "Sem plano de ação. Só o que a auditoria conseguiu sustentar."))
    story.append(Spacer(1, 8 * mm))
    synthesis = report.get("synthesis_bullets") or []
    if synthesis:
        for idx, item in enumerate(synthesis[:8], start=1):
            body = Paragraph(_text(item), styles["body"])
            if body.wrap(146 * mm, doc.height)[1] + 14 * mm > doc.height - 25 * mm:
                story.append(Paragraph(str(idx).zfill(2), styles["h2"]))
                story.append(body)
                story.append(Spacer(1, 5 * mm))
                continue
            card = Table([[str(idx).zfill(2), body]], colWidths=[13 * mm, 154 * mm])
            card.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (0, 0), NAVY), ("TEXTCOLOR", (0, 0), (0, 0), WHITE),
                ("FONTNAME", (0, 0), (0, 0), FONT_BOLD), ("ALIGN", (0, 0), (0, 0), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BACKGROUND", (1, 0), (1, 0), WHITE),
                ("BOX", (0, 0), (-1, -1), .5, LINE), ("LEFTPADDING", (1, 0), (1, 0), 4 * mm),
                ("RIGHTPADDING", (1, 0), (1, 0), 4 * mm), ("TOPPADDING", (0, 0), (-1, -1), 4 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4 * mm),
            ]))
            story.append(card)
            story.append(Spacer(1, 3 * mm))
    story.append(PageBreak())

    # plano bloqueado
    hidden = report.get("hidden_next_steps") or []
    fronts = {str(item.get("front") or "").strip() for item in hidden if str(item.get("front") or "").strip()}
    story.append(SectionBand("07", "O diagnóstico termina aqui", "A investigação revela as vulnerabilidades. A correção é outra etapa."))
    story.append(Spacer(1, 10 * mm))
    story.append(LockedPlan(len(hidden), len(fronts)))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("A investigação mostra onde sua credibilidade quebra. A correção não faz parte deste documento.", styles["lead"]))
    story.append(PageBreak())

    # fontes
    story.append(SectionBand("08", "Evidências verificáveis", "Referências usadas pelos achados apresentados no dossiê."))
    story.append(Spacer(1, 7 * mm))
    if source_urls:
        for url in source_urls[:40]:
            number = source_numbers[url]
            story.append(Paragraph(f"[{number}] <b>{_text(_host(url))}</b><br/><font size='7'>{_text(url)}</font>", styles["small"]))
    else:
        story.append(Paragraph("Nenhuma fonte foi utilizada no material comercial final.", styles["body"]))
    story.append(PageBreak())

    # fechamento
    story.append(Spacer(1, 34 * mm))
    story.append(Paragraph("Agora você sabe onde está vulnerável.", styles["final"]))
    story.append(Paragraph(_text(report.get("final_line") or "O problema já está documentado. A solução não faz parte deste dossiê."), styles["center"]))
    story.append(Spacer(1, 20 * mm))
    story.append(Paragraph("ESTRATÉGIA DE CORREÇÃO - NÃO INCLUÍDA NESTA AUDITORIA", ParagraphStyle("locked-footer", fontName=FONT_BOLD, fontSize=9, leading=12, alignment=TA_CENTER, textColor=RED)))
    story.append(Spacer(1, 28 * mm))
    story.append(Paragraph(f"Dossiê gerado em {datetime.now().strftime('%d/%m/%Y')} a partir de evidências públicas. Relatos e indícios permanecem identificados como tais; ausência de informação não é tratada como irregularidade.", styles["small"]))

    doc.build(story)
    return buffer.getvalue()
