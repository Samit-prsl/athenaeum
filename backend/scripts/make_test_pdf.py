"""Generate simple text-only PDFs for testing Athenaeum (no third-party deps).

Usage: python scripts/make_test_pdf.py
"""

import os

PAGE_W, PAGE_H = 612, 792
LEADING = 18
MARGIN_X = 50
START_Y = 730
LINE_LEN = 95


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _content_stream(text: str) -> bytes:
    lines = []
    for line in text.splitlines() or [""]:
        line = line.strip()
        while len(line) > LINE_LEN:
            cut = line.rfind(" ", 0, LINE_LEN)
            if cut < 40:
                cut = LINE_LEN
            lines.append(line[:cut])
            line = line[cut:].strip()
        lines.append(line)

    commands = ["BT", "/F1 12 Tf"]
    y = START_Y
    for line in lines:
        commands.append(f"{MARGIN_X} {y} Td ({_escape(line)}) Tj")
        y -= LEADING
        if y < 60:
            break
    commands.append("ET")

    data = "\n".join(commands).encode("latin-1")
    return data


def _pdf_bytes(pages: list[str]) -> bytes:
    objs: list[bytes] = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = []
    for i in range(len(pages)):
        kids.append(f"{3 + i * 2} 0 R")
    objs.append(f"<< /Type /Pages /Kids [{ ' '.join(kids) }] /Count {len(pages)} >>".encode())

    font_id = 3 + len(pages) * 2
    for i, text in enumerate(pages):
        content_id = 4 + i * 2
        stream = _content_stream(text)
        objs.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                f"/Contents {content_id} 0 R "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>"
            ).encode()
        )
        objs.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = b"%PDF-1.4\n"
    offsets = [0]
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"

    xref_pos = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    )
    return out


PAGE_1 = """PHOTOSYNTHESIS: ENERGY FROM SUNLIGHT

Photosynthesis is the process by which plants, algae, and some bacteria convert light energy into chemical energy stored in sugar molecules. It occurs primarily in the chloroplasts of plant cells.

The overall balanced equation for photosynthesis is: 6 CO2 + 6 H2O + light energy -> C6H12O6 + 6 O2. Carbon dioxide and water are consumed, and glucose and oxygen gas are produced.

Photosynthesis happens in two major stages: the light-dependent reactions and the light-independent reactions, also known as the Calvin cycle. The light-dependent reactions capture energy from sunlight and produce ATP and NADPH. The Calvin cycle uses ATP and NADPH to convert carbon dioxide into glucose.

CHLOROPLAST STRUCTURE

Chloroplasts are double-membrane organelles. Inside is the stroma, a fluid-filled space, and the thylakoids, flattened membrane sacs stacked into structures called grana. Chlorophyll, the pigment that gives plants their green color, is embedded in the thylakoid membranes and absorbs light most strongly in the blue-violet and red regions of the spectrum."""

PAGE_2 = """LIGHT-DEPENDENT REACTIONS

The light-dependent reactions take place in the thylakoid membranes. When a photon of light strikes a chlorophyll molecule, an electron is excited to a higher energy level. This electron is passed along an electron transport chain, releasing energy that pumps protons into the thylakoid lumen.

The buildup of protons creates an electrochemical gradient. ATP synthase, an enzyme embedded in the thylakoid membrane, uses this gradient to produce ATP in a process called photophosphorylation. Water molecules are split to replace the lost electrons, releasing oxygen gas as a byproduct. The electrons ultimately reduce NADP+ to form NADPH.

Key particles of the light-dependent reactions: Photosystem II absorbs light and initiates the electron transport chain; Photosystem I re-energizes the electrons and passes them to NADP+ reductase to form NADPH. The movement of protons through ATP synthase produces about three ATP molecules per gradient cycle."""

PAGE_3 = """THE CALVIN CYCLE

The Calvin cycle, also called the light-independent reactions or the dark reactions, occurs in the stroma of the chloroplast. It does not require light directly, but it depends on the ATP and NADPH produced by the light-dependent reactions.

The Calvin cycle has three phases: carbon fixation, reduction, and regeneration.

In carbon fixation, the enzyme rubisco attaches carbon dioxide to ribulose biphosphate, or RuBP, a five-carbon molecule. This produces an unstable six-carbon compound that immediately splits into two molecules of 3-phosphoglycerate (3-PGA).

During reduction, ATP and NADPH supply energy and electrons to convert 3-PGA into glyceraldehyde-3-phosphate (G3P). One out of every six G3P molecules exits the cycle to form glucose and other carbohydrates.

In the regeneration phase, the remaining G3P molecules are rearranged and, with the help of ATP, rebuilt into RuBP so the cycle can continue."""

PAGE_4 = """FACTORS AFFECTING PHOTOSYNTHESIS RATE

Several environmental factors limit the rate of photosynthesis. Light intensity increases the rate up to a saturation point beyond which additional light has no effect. Carbon dioxide concentration similarly raises the rate until other factors become limiting. Temperature affects the enzymes involved; photosynthesis slows at very high temperatures because enzymes denature.

The concept of the limiting factor states that the rate of a process is limited by the factor present at its lowest amount. For example, at night or in very dim light, light is the limiting factor; on a bright day in a sealed glasshouse, carbon dioxide may become the limiting factor.

Photorespiration is a wasteful process in which rubisco reacts with oxygen instead of carbon dioxide, producing a two-carbon compound that must be broken down, wasting energy. Some plants, called C4 plants, avoid photorespiration by spatially separating carbon fixation and the Calvin cycle."""

PAGE_5 = """C4 AND CAM PLANTS

C4 plants such as corn and sugarcane have a specialized anatomy called Kranz anatomy. They fix carbon dioxide in mesophyll cells into a four-carbon compound, oxaloacetate, using an enzyme called PEP carboxylase. This compound is transported to bundle sheath cells, where carbon dioxide is released and enters the Calvin cycle.

Because PEP carboxylase does not react with oxygen, C4 plants can concentrate carbon dioxide around rubisco and avoid photorespiration, making them efficient in hot, dry climates.

CAM plants, such as cacti and succulents, collect carbon dioxide at night when stomata are open, converting it to an organic acid stored in vacuoles. During the day, stomata close to conserve water, and the stored acid releases carbon dioxide for the Calvin cycle. This temporal separation lets CAM plants survive extreme desert conditions."""

PAGE_6 = """SUMMARY OF PHOTOSYNTHESIS

Photosynthesis converts light energy into chemical energy stored in glucose. It requires carbon dioxide and water and releases oxygen. The process is powered by the light-dependent reactions, which produce ATP and NADPH, and the Calvin cycle, which uses these molecules to fix carbon dioxide into sugar.

The main structures involved are the thylakoid membranes, where light absorption and the electron transport chain occur, and the stroma, where the Calvin cycle happens. The key enzymes are ATP synthase, rubisco, and NADP+ reductase.

Rate of photosynthesis is influenced by light intensity, carbon dioxide concentration, and temperature. Plants have evolved adaptations like C4 and CAM pathways to limit photorespiration and survive harsh environments."""

CELL_PAGE_1 = """CELL BIOLOGY FUNDAMENTALS

Cells are the basic units of life. All living organisms are composed of cells, and new cells arise from existing cells. The cell theory states these three principles.

Prokaryotic cells, such as bacteria, lack a nucleus and membrane-bound organelles. Their genetic material is a single circular chromosome located in a region called the nucleoid. They are typically smaller and simpler than eukaryotic cells.

Eukaryotic cells possess a true nucleus surrounded by a nuclear membrane and contain membrane-bound organelles such as mitochondria, the endoplasmic reticulum, the Golgi apparatus, and chloroplasts in plant cells.

The plasma membrane is a phospholipid bilayer that separates the cell interior from the outside environment and controls what enters and leaves the cell."""

CELL_PAGE_2 = """ORGANELLES AND THEIR FUNCTIONS

The nucleus houses the cell's DNA and directs cellular activities. The nucleolus inside the nucleus is the site of ribosome assembly.

Mitochondria are the powerhouses of the cell; they carry out cellular respiration, converting glucose and oxygen into ATP, the energy currency of the cell. Mitochondria have a double membrane, with the inner membrane folded into cristae that increase surface area for ATP production.

The endoplasmic reticulum (ER) is a network of membranes. Rough ER is studded with ribosomes and produces proteins destined for secretion or membranes. Smooth ER synthesizes lipids and detoxifies chemicals.

The Golgi apparatus modifies, sorts, and packages proteins and lipids for delivery to their destinations via vesicles.

Ribosomes, made of RNA and protein, are the site of protein synthesis and can be free in the cytoplasm or attached to rough ER."""

CELL_PAGE_3 = """THE CELL CYCLE AND CELL DIVISION

The cell cycle is the series of events that a cell goes through as it grows and divides. It consists of interphase and the mitotic phase.

Interphase is the longest phase and includes G1, S, and G2 stages. In G1 the cell grows and carries out normal functions. During S phase, DNA is replicated, so each chromosome now consists of two sister chromatids joined at the centromere. In G2 the cell prepares for division.

Mitosis has four stages: prophase, metaphase, anaphase, and telophase. In prophase, chromosomes condense and the mitotic spindle forms. In metaphase, chromosomes align at the metaphase plate. In anaphase, sister chromatids separate and move to opposite poles. In telophase, two new nuclei form.

Cytokinesis divides the cytoplasm, and in animal cells a cleavage furrow pinches the cell in two. The result is two genetically identical daughter cells."""

CELL_PAGE_4 = """CELLULAR RESPIRATION

Cellular respiration is the process by which cells harvest energy from organic molecules. The overall equation is: C6H12O6 + 6 O2 -> 6 CO2 + 6 H2O + ATP.

Glycolysis occurs in the cytoplasm and splits glucose into two molecules of pyruvate, producing a net of two ATP and two NADH. It does not require oxygen.

The citric acid cycle, also called the Krebs cycle, occurs in the mitochondrial matrix. Acetyl-CoA enters the cycle, and each turn produces NADH, FADH2, and ATP while releasing carbon dioxide.

Oxidative phosphorylation occurs along the inner mitochondrial membrane. The electron transport chain passes electrons from NADH and FADH2 to oxygen, pumping protons across the membrane. ATP synthase uses this proton gradient to generate most of the cell's ATP."""


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "test_pdfs")
    os.makedirs(out_dir, exist_ok=True)

    generations = {
        "photosynthesis.pdf": [PAGE_1, PAGE_2, PAGE_3, PAGE_4, PAGE_5, PAGE_6],
        "cell_biology.pdf": [CELL_PAGE_1, CELL_PAGE_2, CELL_PAGE_3, CELL_PAGE_4],
    }
    for name, pages in generations.items():
        with open(os.path.join(out_dir, name), "wb") as fh:
            fh.write(_pdf_bytes(pages))
        print(f"wrote {name} ({len(pages)} pages)")


if __name__ == "__main__":
    main()