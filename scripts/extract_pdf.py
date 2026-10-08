import os
import pypdf

def extract_text_from_pdf(pdf_path):
    """
    Extracts raw text and page mappings from the portfolio knowledge PDF.
    Returns a list of dicts: [{'page': 1, 'text': '...'}, ...]
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found at path: {pdf_path}")

    reader = pypdf.PdfReader(pdf_path)
    pages_data = []

    for page_num, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        # Clean header/footer artifacts if necessary
        cleaned_lines = []
        for line in text.split("\n"):
            line_str = line.strip()
            # Ignore running headers/footers
            if line_str.startswith("Prince Singh") and "RAG Portfolio Knowledge Base" in line_str:
                continue
            if line_str.startswith("Page ") and line_str.replace("Page ", "").isdigit():
                continue
            cleaned_lines.append(line)

        pages_data.append({
            "page": page_num,
            "text": "\n".join(cleaned_lines).strip()
        })

    return pages_data
