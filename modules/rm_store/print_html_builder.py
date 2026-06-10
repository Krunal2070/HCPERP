# -*- coding: utf-8 -*-
"""
print_html_builder.py — Procurement-style production print sheets.

Generates the same landscape A4 look as the procurement module's Formulation
Detail print (fvq_viewer.js _buildPrintHtml), but driven server-side and split
into two independent documents:

  print_type = 'front'    → Formulation sheet (ingredient table) ONLY.
                            No manufacturing process. Two blank write-in columns
                            after Qty for hand recording.
  print_type = 'process'  → Manufacturing process / product-specification page
                            ONLY. No ingredient table.

Quantity per ingredient = concentration × batch_size   (matches procurement,
the RM calculator, and the costing Excel).

Decimals: quantities and concentrations are formatted with up to 10 decimals,
trailing zeros trimmed (18 -> "18", 10.8 -> "10.8", 0.000005566 ->
"0.000005566").
"""

from html import escape as _esc, unescape as _unesc
from datetime import date as _date


def _fmt_qty(value, max_dp=10):
    """Up to `max_dp` decimals, trailing zeros trimmed.
    18.0 -> '18', 10.8 -> '10.8', 1755.898 -> '1755.898',
    0.000005566 -> '0.000005566'. Blank/invalid -> ''."""
    if value is None or value == '':
        return ''
    try:
        n = float(value)
    except (TypeError, ValueError):
        return ''
    s = f'{n:.{max_dp}f}'.rstrip('0').rstrip('.')
    return s if s else '0'


def _conc_frac(value):
    """Normalize a stored concentration to a FRACTION (≤ 1).
    Fraction form (0.9755) stays; percent form (33.535, or '5%') → /100.
    A bare number > 1 is treated as a percentage."""
    if value is None:
        return 0.0
    raw = str(value).strip()
    if not raw:
        return 0.0
    if '%' in raw:
        try:
            return float(raw.replace('%', '').strip()) / 100.0
        except (ValueError, TypeError):
            return 0.0
    try:
        v = float(raw)
    except (ValueError, TypeError):
        return 0.0
    return v / 100.0 if v > 1 else v


def _fmt_conc_pct(conc_fraction, max_dp=10):
    """Concentration fraction -> percentage string, trailing zeros trimmed.
    0.975499 -> '97.5499%', 0.01 -> '1%', 0.0000001 -> '0.00001%'."""
    if conc_fraction is None:
        return ''
    try:
        pct = float(conc_fraction) * 100.0
    except (TypeError, ValueError):
        return ''
    s = f'{pct:.{max_dp}f}'.rstrip('0').rstrip('.')
    return (s if s else '0') + '%'


# Shared CSS — mirrors procurement fvq_viewer.js print styling.
_BASE_CSS = """
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{ font-family:'DM Sans','Segoe UI',sans-serif; font-size:8pt; color:#000; background:#fff; }
.hdr{ margin-bottom:2.5mm; display:flex; justify-content:space-between; align-items:flex-start; }
.hdr-left .co{ font-size:6.5pt; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#777; margin-bottom:1mm; }
.hdr-left .ti{ font-size:12pt; font-weight:700; color:#000; line-height:1.2; }
.hdr-left .pc-inline{ font-size:8pt; color:#444; font-weight:500; font-family:'DM Mono',monospace; }
.hdr-left .pc-inline .pc-label{ color:#777; font-weight:600; }
.hdr-left .pc-inline strong{ color:#000; font-weight:700; }
.hdr-right{ text-align:right; font-size:7pt; color:#444; line-height:1.7; }
.hdr-right .bs{ font-size:10pt; font-weight:700; color:#000; font-family:'DM Mono',monospace; }
.type-badge{ display:inline-block; font-size:6.5pt; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; padding:1.5px 7px; border-radius:3px; margin-bottom:2mm;
    background:#f2f2f2; color:#000; border:1pt solid #999; }
.meta{ display:flex; gap:6mm; align-items:center; padding:1.6mm 4mm; background:#f8fafc;
    border:1pt solid #e2e8f0; border-radius:3px; margin-bottom:2.5mm; font-size:7pt; }
.meta-item{ display:flex; flex-direction:column; gap:0.5px; }
.ml{ font-size:6pt; font-weight:700; letter-spacing:.9px; text-transform:uppercase; color:#777; }
.mv{ font-family:'DM Mono',monospace; font-weight:600; color:#000; font-size:8pt; }
.mv.hi{ color:#000; }
.meta-sep{ width:1pt; background:#e2e8f0; align-self:stretch; margin:0 1mm; }
table{ width:100%; border-collapse:collapse; font-size:10.5pt; table-layout:fixed; }
col.c-sr { width:8mm; } col.c-ing { width:48mm; } col.c-sup { width:42mm; }
col.c-con { width:20mm; } col.c-qty { width:22mm; } col.c-blk{ width:18mm; }
thead tr{ background:#000; }
thead th{ padding:1.6mm 2.5mm; font-size:6.5pt; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; color:#fff; text-align:left;
    border-right:1pt solid rgba(255,255,255,.15); white-space:nowrap; overflow:hidden; }
thead th:last-child{ border-right:none; }
tbody tr{ border-bottom:.5pt solid #e8ecf2; }
tbody tr.alt td{ background:#f8fafc; }
tbody td{ padding:0.5mm 2.5mm; line-height:1.1; vertical-align:middle; border-right:.5pt solid #eef0f4; overflow:hidden; white-space:nowrap; }
tbody td:last-child{ border-right:none; }
td.sr{ color:#777; font-family:'DM Mono',monospace; font-size:9pt; text-align:center; }
td.ing{ font-weight:600; font-size:10.5pt; }
td.sup{ color:#333; font-size:9pt; }
td.con{ font-family:'DM Mono',monospace; color:#000; font-weight:600; text-align:right; }
td.qty{ font-family:'DM Mono',monospace; font-weight:700; font-size:10.5pt; text-align:right; }
tr.tot td{ padding:1.4mm 2.5mm; background:#f2f2f2;
    border-top:1.5pt solid #000; border-bottom:1.5pt solid #000;
    font-size:8pt; border-right:.5pt solid #ccc; }
tr.tot td.con{ color:#000; }
.ftr{ margin-top:2mm; padding-top:1.5mm; border-top:1pt solid #e2e8f0;
    display:flex; justify-content:space-between; align-items:flex-end;
    font-size:6.5pt; color:#777; }
.sign-row{ display:flex; gap:14mm; }
.sb{ text-align:center; min-width:36mm; }
.sl{ border-top:.75pt solid #cbd5e1; padding-top:1mm; margin-top:6mm; font-weight:600; color:#333; font-size:7pt; }
#form-shell{ width:277mm; height:194mm; overflow:hidden; }
#form-wrap{ width:100%; transform-origin:top left; }
.mp-hdr{ margin-bottom:2.5mm; display:flex; justify-content:space-between; align-items:flex-start;
    border-bottom:2pt solid #000; padding-bottom:2mm; }
.mp-hdr-left .mp-co{ font-size:6.5pt; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#777; margin-bottom:1mm; }
.mp-hdr-left .mp-ti{ font-size:11pt; font-weight:700; color:#000; line-height:1.2; }
.mp-hdr-left .mp-pc{ font-size:7.5pt; color:#444; font-weight:500; font-family:'DM Mono',monospace; }
.mp-hdr-left .mp-pc .mp-pc-l{ color:#777; font-weight:600; }
.mp-hdr-left .mp-pc strong{ color:#000; font-weight:700; }
.mp-hdr-right{ text-align:right; font-size:7pt; color:#444; line-height:1.7; }
.mp-hdr-right .mp-bs{ font-size:10pt; font-weight:700; color:#000; font-family:'DM Mono',monospace; }
.mp-body{ font-size:7.5pt; color:#000; line-height:1.5; }
.mp-body p{ margin:0.6mm 0; }
.mp-body ol, .mp-body ul{ margin:0.8mm 0 1.5mm 7mm; padding:0; }
.mp-body li{ margin:0.4mm 0; padding-left:1mm; }
.mp-body b, .mp-body strong{ font-weight:700; }
.mp-body table{ border-collapse:collapse; width:100%; max-width:100%; font-size:7pt;
    table-layout:auto; margin:1.5mm 0; word-wrap:break-word; }
.mp-body td, .mp-body th{ border:.75pt solid #cbd5e1; padding:1mm 2mm;
    vertical-align:top; word-wrap:break-word; overflow-wrap:break-word; word-break:break-word; }
.mp-body th{ background:#f1f5f9; font-weight:700; text-align:center; }
.mp-body table.mp-spec{ table-layout:fixed; font-size:7.5pt; margin:0 0 3mm 0; }
.mp-body img{ max-width:100%; height:auto; }
#mp-shell{ width:277mm; height:194mm; overflow:hidden; }
#mp-wrap{ width:100%; transform-origin:top left; }
.mp-ftr{ margin-top:3mm; padding-top:2mm; border-top:1pt solid #e2e8f0;
    display:flex; justify-content:space-between; align-items:flex-end;
    font-size:6.5pt; color:#777; }
"""

import re as _re_norm

def _manuf_to_text_rows(raw_html):
    """Reduce ANY manuf_process HTML to a flat list of text lines.

    We deliberately IGNORE the source table/column structure. Every <tr> (or
    block element / <br> for non-table content) becomes ONE logical line, with
    its cell texts joined by a tab so we can still tell columns apart if useful.
    Empty fragments are dropped. This is the foundation for building our own
    format from the text alone.
    """
    if not raw_html:
        return []
    text_lines = []
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(raw_html or '', 'html.parser')
        trs = soup.find_all('tr')
        if trs:
            for tr in trs:
                parts = [c.get_text(' ', strip=True).replace('\xa0', ' ').strip()
                         for c in tr.find_all(['td', 'th'])]
                parts = [p for p in parts if p]
                if parts:
                    text_lines.append('\t'.join(parts))
        else:
            for br in soup.find_all('br'):
                br.replace_with('\n')
            for raw_line in soup.get_text('\n').split('\n'):
                ln = raw_line.replace('\xa0', ' ').strip()
                if ln:
                    text_lines.append(ln)
    except Exception:
        # Last resort: crude tag strip
        import re as _re
        txt = _re.sub(r'<[^>]+>', '\n', raw_html or '')
        for ln in txt.split('\n'):
            ln = ln.strip()
            if ln:
                text_lines.append(ln)
    return text_lines


def _rebuild_manuf_html(raw_html):
    """Build OUR OWN format from the process TEXT, ignoring source structure.

    Output = up to two clean tables:
      • PRODUCT SPECIFICATION  → Parameter | Observation (Result)
      • MANUFACTURING PROCESS  → No. | Step

    Parsing rules (text-pattern based, structure-agnostic):
      - A line containing 'product specification' starts the spec section.
      - A line that is just a number, or starts 'N something', is a step.
      - 'Product Name...' / a lone 'Manufacturing Process' line are skipped.
      - In the spec section, a tab-split line → (parameter, value); a single
        token line with a following value line is paired up.
    Always returns rebuilt HTML (never the raw source), so the print can't fall
    back to the messy original.
    """
    lines = _manuf_to_text_rows(raw_html)
    if not lines:
        return ('<p style="color:#777">No manufacturing process recorded '
                'for this batch.</p>')

    import re as _re
    serial_lead = _re.compile(r'^\s*(\d+)\s*[.)]?\s+(.*\S)\s*$')   # "1. text" / "1 text"
    serial_only = _re.compile(r'^\s*(\d+)\s*[.)]?\s*$')            # "1" alone

    spec = []        # [(param, value)]  — when source gives 2-col rows
    spec_flat = []   # [str]             — when source gives 1 value per row
    steps = []       # [(num, text)]
    mode = None      # None | 'spec' | 'steps'
    pending_serial = None

    def _clean(s):
        # Decode any leftover HTML entities (e.g. literal "&amp;") so the final
        # _esc() produces a single correct encoding, not "&amp;amp;".
        return _re.sub(r'\s+', ' ', _unesc(s or '')).strip()

    for ln in lines:
        cols = [c.strip() for c in ln.split('\t') if c.strip()]
        flat = _clean(' '.join(cols))
        low = flat.lower()

        # Section switches / skips
        if 'product specification' in low:
            mode = 'spec'; continue
        if low.startswith('product name'):
            continue
        if low == 'manufacturing process' or low.startswith('manufacturing process for'):
            mode = 'steps'; continue

        # Step detection (works in any mode once a number appears)
        m_lead = serial_lead.match(flat)
        m_only = serial_only.match(cols[0]) if cols else None

        if mode == 'spec' and not (m_lead or m_only):
            # Two real columns → a paired row. One column → a flat value we will
            # pair up afterwards (source puts each param/value on its own line).
            if len(cols) >= 2:
                spec.append((cols[0], _clean(' '.join(cols[1:]))))
            elif len(cols) == 1:
                spec_flat.append(cols[0])
            continue

        # Steps
        if m_only and len(cols) >= 2:
            steps.append((int(m_only.group(1)), _clean(' '.join(cols[1:]))))
            mode = 'steps'; pending_serial = None
        elif m_lead:
            steps.append((int(m_lead.group(1)), _clean(m_lead.group(2))))
            mode = 'steps'; pending_serial = None
        elif m_only:
            pending_serial = int(m_only.group(1)); mode = 'steps'
        elif mode == 'steps':
            # continuation line or numberless step
            if pending_serial is not None:
                steps.append((pending_serial, flat)); pending_serial = None
            elif steps:
                steps[-1] = (steps[-1][0], _clean(steps[-1][1] + ' ' + flat))
            else:
                steps.append((len(steps) + 1, flat))
        # else: pre-section noise → ignore

    # ── Pair flat spec values (source listed each param/value on its own line) ──
    if spec_flat and not spec:
        for i in range(0, len(spec_flat) - 1, 2):
            spec.append((spec_flat[i], spec_flat[i + 1]))
        if len(spec_flat) % 2 == 1:        # dangling param with no value
            spec.append((spec_flat[-1], ''))

    # ── Emit OUR format ──
    pieces = []

    if spec:
        # Drop a leading header row like ("Parameters","Observation (Result)")
        data = list(spec)
        if data and (data[0][0].lower().startswith(('parameter', 'paramerter'))
                     or data[0][1].lower().startswith('observation')):
            data = data[1:]
        t = ['<table class="mp-clean"><!--mpclean-v10-->',
             '<colgroup><col style="width:34%"><col></colgroup>',
             '<tr><td colspan="2" class="hd">PRODUCT SPECIFICATION</td></tr>',
             '<tr><th class="lbl">Parameters</th><th>Observation (Result)</th></tr>']
        for prm, val in data:
            # Skip rows with no real data (empty parameter AND empty value).
            if not prm.strip() and not val.strip():
                continue
            t.append(f'<tr><td class="lbl">{_esc(prm)}</td><td>{_esc(val)}</td></tr>')
        t.append('</table>')
        pieces.append(''.join(t))

    if steps:
        # Renumber sequentially for a clean sheet; skip empty step text.
        t = ['<table class="mp-clean">',
             '<colgroup><col style="width:14mm"><col></colgroup>',
             '<tr><td colspan="2" class="hd">MANUFACTURING PROCESS</td></tr>']
        n = 0
        for _, text in steps:
            if not text.strip():
                continue
            n += 1
            t.append(f'<tr><td class="sr">{n}</td><td>{_esc(text)}</td></tr>')
        t.append('</table>')
        pieces.append(''.join(t))

    if not pieces:
        # No structure detected — render the lines as plain numbered text.
        t = ['<table class="mp-clean"><!--mpclean-v10-->',
             '<colgroup><col></colgroup>']
        for ln in lines:
            t.append(f'<tr><td>{_esc(_clean(ln.replace(chr(9)," ")))}</td></tr>')
        t.append('</table>')
        pieces.append(''.join(t))

    return ''.join(pieces)


def _normalize_manuf_html(html):
    return _rebuild_manuf_html(html)


_SIGN_ROW = (
    '<div class="sign-row">'
    '<div class="sb"><div style="height:8mm"></div><div class="sl">Batch Dispenser</div></div>'
    '<div class="sb"><div style="height:8mm"></div><div class="sl">Batch Incharge</div></div>'
    '<div class="sb"><div style="height:8mm"></div><div class="sl">Approved By</div></div>'
    '</div>'
)

# Auto-fit + auto-print script (mirrors procurement). Scales the page to fit
# one landscape A4, waits for fonts, then fires window.print().
_FIT_SCRIPT = """
<script>
window.onload=function(){
    function fit(shellId,wrapId){
        var s=document.getElementById(shellId),w=document.getElementById(wrapId);
        if(!s||!w)return;
        w.style.transform='';w.style.width='';w.style.height='';
        var sw=s.clientWidth,sh=s.clientHeight,ww=w.scrollWidth,wh=w.scrollHeight;
        if(wh>sh||ww>sw){
            var r=Math.min(sw/ww,sh/wh);
            w.style.transformOrigin='top left';
            w.style.transform='scale('+r+')';
            w.style.width=(100/r)+'%';
        }
    }
    function doFit(){ fit('form-shell','form-wrap'); fit('mp-shell','mp-wrap'); }
    doFit();
    if(document.fonts&&document.fonts.ready){
        document.fonts.ready.then(function(){ doFit(); setTimeout(function(){ doFit(); window.print(); },120); });
    } else {
        setTimeout(function(){ doFit(); window.print(); },400);
    }
};
</script>
"""


def _page_css(orientation):
    return f"@page{{ size:A4 {orientation}; margin:8mm 10mm; }}\nhtml,body{{ width:277mm; }}"


def build_front_html(batch_name, product_code, batch_size, ingredients, print_date=None, show_conc=False):
    """Formulation sheet only (ingredient table + 2 blank write-in columns).
    `ingredients`: list of dicts with material_name, supplier_name, concentration.
    Qty = concentration × batch_size.
    `show_conc`: when False (default) the Conc. % column and Total Conc. chip
    are hidden — operators only see quantity."""
    if print_date is None:
        print_date = _date.today().strftime('%d %b %Y')

    total_conc = 0.0
    total_qty = 0.0
    rows_html = []
    for i, ing in enumerate(ingredients):
        conc = _conc_frac(ing.get('concentration'))
        qty = conc * batch_size if batch_size else 0.0
        total_conc += conc
        total_qty += qty
        rows_html.append(
            f'<tr class="{"alt" if i % 2 == 0 else ""}">'
            f'<td class="sr">{i + 1}</td>'
            f'<td class="ing">{_esc(str(ing.get("material_name") or ""))}</td>'
            f'<td class="sup">{_esc(str(ing.get("supplier_name") or ""))}</td>'
            + (f'<td class="con">{_fmt_conc_pct(conc)}</td>' if show_conc else '')
            + f'<td class="qty">{_fmt_qty(qty)}</td>'
            f'<td></td><td></td>'   # two blank write-in columns
            f'</tr>'
        )
    rows_joined = ''.join(rows_html)

    total_row = (
        '<tr class="tot">'
        '<td></td><td style="font-weight:700">TOTAL</td><td></td>'
        + (f'<td class="con" style="font-weight:700">{_fmt_conc_pct(total_conc, max_dp=2)}</td>' if show_conc else '')
        + f'<td class="qty" style="font-weight:700">{_fmt_qty(total_qty) if batch_size else ""}</td>'
        '<td></td><td></td>'
        '</tr>'
    )

    pc_inline = (
        f'<span class="pc-inline"> &nbsp;·&nbsp; <span class="pc-label">Product Code:</span> '
        f'<strong>{_esc(product_code)}</strong></span>'
    ) if product_code else ''

    bs_block = (
        f'<div class="bs">{_fmt_qty(batch_size)} KG</div>'
        f'<div style="font-size:6pt">Batch Size</div>'
    ) if batch_size else ''

    # Concentration column is optional (hidden by default).
    conc_col    = '<col class="c-con">' if show_conc else ''
    conc_th     = '<th style="text-align:right">Conc. % w/w</th>' if show_conc else ''

    # Optional meta bar — only shows Total Conc. when concentration is enabled.
    # (The ingredient count line is intentionally omitted.)
    meta_bar = (
        '<div class="meta">'
        f'<div class="meta-item"><span class="ml">Total Conc.</span>'
        f'<span class="mv hi">{_fmt_conc_pct(total_conc, max_dp=2)}</span></div>'
        '</div>'
    ) if show_conc else ''

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Production Sheet — {_esc(batch_name)}</title>
<style>{_page_css('landscape')}{_BASE_CSS}</style></head>
<body>
<div id="form-shell"><div id="form-wrap">
<div class="hdr">
  <div class="hdr-left">
    <div class="co">HCP Wellness Pvt Ltd &nbsp;·&nbsp; Formulation Sheet</div>
    <div class="type-badge">Production Sheet</div>
    <div class="ti">{_esc(batch_name)}{pc_inline}</div>
  </div>
  <div class="hdr-right">
    <div>Date: <strong>{_esc(print_date)}</strong></div>
    {bs_block}
  </div>
</div>
{meta_bar}
<table>
  <colgroup>
    <col class="c-sr"><col class="c-ing"><col class="c-sup">
    {conc_col}<col class="c-qty"><col class="c-blk"><col class="c-blk">
  </colgroup>
  <thead><tr>
    <th>#</th><th>Ingredient / Material</th><th>Supplier</th>
    {conc_th}
    <th style="text-align:right">Qty (KG)</th>
    <th></th><th></th>
  </tr></thead>
  <tbody>{rows_joined}{total_row}</tbody>
</table>
<div class="ftr">
  <div><strong>HCP Wellness Pvt Ltd</strong> &nbsp;·&nbsp; Production Sheet &nbsp;·&nbsp; Printed: {_esc(print_date)}</div>
  {_SIGN_ROW}
</div>
</div></div>
{_FIT_SCRIPT}
</body></html>"""


def build_process_html(batch_name, product_code, batch_size, manuf_process_html, print_date=None):
    """Manufacturing process / product-specification page (PORTRAIT A4).
    Mirrors the procurement module's printManufProcess layout: the stored
    manuf_process HTML (already containing canonical spec/steps tables) is
    placed inside a bordered panel under a step label. Black & white."""
    if print_date is None:
        print_date = _date.today().strftime('%d %b %Y')

    pc = f'<div class="pc">Product Code: <strong>{_esc(product_code)}</strong></div>' if product_code else ''
    bs = (f'<div class="bs">{_fmt_qty(batch_size)} KG</div><div style="font-size:5.5pt">Batch Size</div>'
          if batch_size else '')
    content = _normalize_manuf_html(manuf_process_html) or '<p style="color:#777">No manufacturing process recorded for this batch.</p>'

    css = """
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
@page{ size:A4 landscape; margin:0; }
html,body{ width:297mm; height:210mm; overflow:hidden; font-family:'DM Sans','Segoe UI',sans-serif; color:#000; background:#fff; }
#shell{ width:297mm; height:210mm; padding:6mm 12mm; box-sizing:border-box; overflow:hidden; display:flex; flex-direction:column; }
#wrap{ flex:1; display:flex; flex-direction:column; transform-origin:top left; min-height:0; font-size:9pt; }
.hdr{ margin-bottom:2mm; display:flex; justify-content:space-between; align-items:center; border-bottom:1.5pt solid #000; padding-bottom:1.5mm; flex-shrink:0; }
.hdr-left .co{ font-size:5.5pt; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#777; margin-bottom:0.5mm; }
.hdr-left .ti{ font-size:10pt; font-weight:700; color:#000; line-height:1.1; }
.hdr-left .pc{ font-size:6.5pt; color:#444; margin-top:0.3mm; font-family:'DM Mono',monospace; }
.hdr-right{ text-align:right; font-size:6pt; color:#444; line-height:1.4; }
.hdr-right .bs{ font-size:8.5pt; font-weight:700; color:#000; font-family:'DM Mono',monospace; }
.type-badge{ display:inline-block; font-size:5pt; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
    padding:1px 4px; border-radius:3px; margin-bottom:1mm; background:#f2f2f2; color:#000; border:1pt solid #999; }
.slabel{ font-size:6pt; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#444;
    border-left:3pt solid #000; padding-left:3mm; margin-bottom:1.5mm; flex-shrink:0; }
.pbody{ font-size:1em; color:#000; line-height:1.4; padding:2mm; background:#fff; border:1pt solid #999; border-radius:3px; flex:1; overflow:hidden; }
.pbody ol,.pbody ul{ margin:1mm 0 1mm 5mm; padding:0; }
.pbody li{ margin:.6mm 0; }
.pbody b,.pbody strong{ font-weight:700; }
.pbody table{ border-collapse:collapse; width:100%; font-size:1em; margin:1.5mm 0; table-layout:fixed; }
.pbody td,.pbody th{ border:.75pt solid #000; padding:0.6mm 2mm; vertical-align:top; word-wrap:break-word; }
.pbody th{ background:#f2f2f2; font-weight:700; text-align:center; }
.pbody table.mp-spec td,.pbody table.mp-spec th{ font-size:9pt; }
.pbody table.mp-steps td,.pbody table.mp-steps th{ font-size:9pt; }
.pbody td.sr{ text-align:center; color:#444; font-family:'DM Mono',monospace; font-size:8.5pt; width:12mm; white-space:nowrap; }
.pbody table.mp-clean{ table-layout:fixed; font-size:1em; }
.pbody table.mp-clean td{ font-size:1em; line-height:1.35; }
.pbody table.mp-clean td.sr{ width:14mm; text-align:center; color:#444; font-family:'DM Mono',monospace; vertical-align:top; }
.pbody table.mp-clean td.lbl, .pbody table.mp-clean th.lbl{ font-weight:600; }
.pbody table.mp-clean th{ background:#f2f2f2; font-weight:700; text-align:left; }
.pbody table.mp-clean td.hd{ font-weight:700; background:#f2f2f2; text-align:center; }
.pbody img{ max-width:100%; height:auto; }
.ftr{ margin-top:2mm; padding-top:2mm; border-top:1pt solid #999; flex-shrink:0; display:flex; justify-content:space-between; align-items:flex-end; font-size:6pt; color:#777; }
.sign-row{ display:flex; gap:12mm; }
.sb{ text-align:center; min-width:32mm; }
.sl{ border-top:.75pt solid #999; padding-top:1mm; margin-top:8mm; font-weight:600; color:#333; font-size:6.5pt; }
"""

    script = """
<script>
window.onload=function(){
    function fitFont(){
        var s=document.getElementById('shell'),w=document.getElementById('wrap');
        var pb=document.querySelector('.pbody');
        if(!s||!w)return;
        // Let content take its natural height during measurement (no flex stretch,
        // no clipping) so scrollHeight reflects the TRUE content size.
        var prevPbOv = pb ? pb.style.overflow : '';
        var prevPbFlex = pb ? pb.style.flex : '';
        if(pb){ pb.style.overflow='visible'; pb.style.flex='none'; }
        w.style.transform=''; w.style.width=''; w.style.height='auto';

        // Target box = shell's inner content area, minus a safety margin so the
        // final line never spills onto a second page when the printer rounds.
        var availW = s.clientWidth;
        var availH = s.clientHeight * 0.97;   // 3% bottom safety margin

        function fits(pt){
            w.style.fontSize=pt+'pt';
            // Force reflow, then compare real content size to the target box.
            return (w.scrollHeight <= availH) && (w.scrollWidth <= availW);
        }

        // Binary-search the largest base font (pt) that fits the page.
        var lo=4.0, hi=14, best=lo;
        for(var i=0;i<22;i++){
            var mid=(lo+hi)/2;
            if(fits(mid)){ best=mid; lo=mid; } else { hi=mid; }
        }
        w.style.fontSize=best+'pt';

        // Restore layout styling.
        if(pb){ pb.style.overflow=prevPbOv; pb.style.flex=prevPbFlex; }

        // Final safety net: if anything still overflows (e.g. an unbreakable long
        // word), scale the whole block down to guarantee one-page output.
        if(w.scrollHeight > s.clientHeight || w.scrollWidth > s.clientWidth){
            var r=Math.min(s.clientWidth/w.scrollWidth, (s.clientHeight*0.99)/w.scrollHeight);
            w.style.transformOrigin='top left';
            w.style.transform='scale('+r+')';
            w.style.width=(100/r)+'%';
        }
    }
    fitFont();
    if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){fitFont();window.print();});
    else setTimeout(function(){fitFont();window.print();},400);
};
</script>
"""

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Manufacturing Process — {_esc(batch_name)}</title>
<style>{css}</style></head>
<body>
<div id="shell"><div id="wrap">
<div class="hdr">
  <div class="hdr-left">
    <div class="co">HCP Wellness Pvt Ltd &nbsp;·&nbsp; Manufacturing Process</div>
    <div class="type-badge">Process Sheet</div>
    <div class="ti">{_esc(batch_name)}</div>
    {pc}
  </div>
  <div class="hdr-right">
    <div>Date: <strong>{_esc(print_date)}</strong></div>
    {bs}
  </div>
</div>
<div class="slabel">Step-by-Step Manufacturing Process <span style="color:#999;font-weight:400">· v10 fit</span></div>
<div class="pbody">{content}</div>
<div class="ftr">
  <div><strong>HCP Wellness Pvt Ltd</strong> &nbsp;·&nbsp; Process Sheet &nbsp;·&nbsp; Printed: {_esc(print_date)}</div>
  <div class="sign-row">
    <div class="sb"><div class="sl">Batch Dispenser</div></div>
    <div class="sb"><div class="sl">Batch Incharge</div></div>
    <div class="sb"><div class="sl">Approved By</div></div>
  </div>
</div>
</div></div>
{script}
</body></html>"""


# ── Combine multiple sheet documents into ONE print document ──────────────────
import re as _re_comb

def build_combined_html(sheet_htmls):
    """Given a list of complete sheet HTML documents (front and/or process,
    already repeated per copies), return ONE HTML document that prints them all
    in a single print dialog — one page each, in order.

    Each source sheet uses #shell/#wrap with its own <style> and a per-document
    fit script. We extract each sheet's <style> blocks and <body> inner content,
    rewrite the per-sheet ids (#shell/#wrap) to unique ids so multiple pages can
    coexist, drop the per-sheet auto-print scripts, and add ONE combined fit +
    print routine that processes every page.
    """
    if not sheet_htmls:
        return '<!DOCTYPE html><html><body></body></html>'
    if len(sheet_htmls) == 1:
        return sheet_htmls[0]

    style_blocks = []
    pages = []
    for idx, doc in enumerate(sheet_htmls):
        # Collect <style>…</style> (dedupe identical blocks)
        for m in _re_comb.finditer(r'<style[^>]*>(.*?)</style>', doc, _re_comb.DOTALL | _re_comb.IGNORECASE):
            css = m.group(1)
            if css not in style_blocks:
                style_blocks.append(css)
        # Extract <body>…</body> inner content
        bm = _re_comb.search(r'<body[^>]*>(.*?)</body>', doc, _re_comb.DOTALL | _re_comb.IGNORECASE)
        body = bm.group(1) if bm else doc
        # Remove any per-sheet <script> (auto-print) blocks
        body = _re_comb.sub(r'<script[^>]*>.*?</script>', '', body, flags=_re_comb.DOTALL | _re_comb.IGNORECASE)
        # Make shell/wrap ids unique per page so the combined fitter can target each
        body = body.replace('id="shell"', f'id="shell{idx}" class="pg-shell"')
        body = body.replace('id="wrap"',  f'id="wrap{idx}" class="pg-wrap"')
        body = body.replace('id="form-shell"', f'id="form-shell{idx}" class="pg-shell"')
        body = body.replace('id="form-wrap"',  f'id="form-wrap{idx}" class="pg-wrap"')
        pages.append(f'<div class="print-page">{body}</div>')

    combined_css = '\n'.join(style_blocks)
    pages_html = '\n'.join(pages)

    fit_and_print = """
<script>
window.onload=function(){
    function fitOne(shell, wrap){
        if(!shell||!wrap) return;
        var pb = shell.querySelector('.pbody');
        var prevOv = pb?pb.style.overflow:'', prevFlex = pb?pb.style.flex:'';
        if(pb){ pb.style.overflow='visible'; pb.style.flex='none'; }
        wrap.style.transform=''; wrap.style.width=''; wrap.style.height='auto';
        var availW = shell.clientWidth, availH = shell.clientHeight*0.97;
        function fits(pt){ wrap.style.fontSize=pt+'pt';
            return (wrap.scrollHeight<=availH)&&(wrap.scrollWidth<=availW); }
        var lo=4.0, hi=14, best=lo;
        for(var i=0;i<20;i++){ var mid=(lo+hi)/2; if(fits(mid)){best=mid;lo=mid;}else{hi=mid;} }
        wrap.style.fontSize=best+'pt';
        if(pb){ pb.style.overflow=prevOv; pb.style.flex=prevFlex; }
        if(wrap.scrollHeight>shell.clientHeight||wrap.scrollWidth>shell.clientWidth){
            var r=Math.min(shell.clientWidth/wrap.scrollWidth,(shell.clientHeight*0.99)/wrap.scrollHeight);
            wrap.style.transformOrigin='top left'; wrap.style.transform='scale('+r+')'; wrap.style.width=(100/r)+'%';
        }
    }
    function fitAll(){
        var shells=document.querySelectorAll('.pg-shell');
        shells.forEach(function(sh){
            var wr = sh.querySelector('.pg-wrap');
            fitOne(sh, wr);
        });
    }
    fitAll();
    if(document.fonts&&document.fonts.ready)
        document.fonts.ready.then(function(){ fitAll(); setTimeout(function(){window.print();},150); });
    else setTimeout(function(){ fitAll(); window.print(); }, 450);
};
</script>
"""

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Production Sheets</title>
<style>
{combined_css}
/* ── Authoritative page rules for the COMBINED document (override per-sheet) ── */
@page {{ size: A4 landscape; margin: 6mm 8mm; }}
html, body {{ width: auto; height: auto; overflow: visible; background: #fff; }}
/* Normalise each sheet's shell to the printable area so one sheet = one page. */
.pg-shell {{ width: 281mm !important; height: 192mm !important; box-sizing: border-box !important; overflow: hidden !important; }}
/* Each sheet occupies exactly one physical page; hard break after. */
.print-page{{ page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; overflow: hidden; }}
.print-page:last-child{{ page-break-after: auto; break-after: auto; }}
</style></head>
<body>
{pages_html}
{fit_and_print}
</body></html>"""
