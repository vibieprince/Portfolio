import os
import sys
import argparse
import glob
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from extract_pdf import extract_text_from_pdf
from chunk import chunk_pdf_pages

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "768"))

def get_supabase_client():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables must be set.")
    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def get_gemini_client():
    if not GEMINI_API_KEY:
        print("Warning: GEMINI_API_KEY environment variable not set. Gemini API calls will fail.")
        return None
    try:
        from google import genai
        return genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        print(f"Notice initializing Google GenAI Client: {e}")
        return None

def generate_embedding(text, gemini_client):
    """
    Generates 768-dim vector embedding using gemini-embedding-2.
    """
    if not GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY is required for embedding generation.")

    if gemini_client:
        try:
            response = gemini_client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=text,
                config={
                    "task_type": "RETRIEVAL_DOCUMENT",
                    "output_dimensionality": EMBEDDING_DIMENSION
                }
            )
            return response.embedding.values
        except Exception as e:
            print(f"Gemini SDK embed failed, falling back to direct REST API: {e}")

    # Fallback to direct HTTP REST API call
    import requests
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBEDDING_MODEL}:embedContent?key={GEMINI_API_KEY}"
    payload = {
        "model": f"models/{EMBEDDING_MODEL}",
        "content": {"parts": [{"text": text}]},
        "taskType": "RETRIEVAL_DOCUMENT",
        "outputDimensionality": EMBEDDING_DIMENSION
    }
    res = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=30)
    if res.status_code == 200:
        return res.json()["embedding"]["values"]
    else:
        raise RuntimeError(f"Gemini Embedding API Error (HTTP {res.status_code}): {res.text}")

def find_canonical_pdf(base_dir="images"):
    """
    Locates the canonical portfolio knowledge PDF.
    Prefers 'Prince Knowledge base.pdf' or 'prince-portfolio-knowledge.pdf'.
    Fails clearly if no PDF or multiple conflicting PDFs exist.
    """
    pdf_files = glob.glob(os.path.join(base_dir, "*.pdf"))
    if not pdf_files:
        # Check root or parent directories as fallback
        pdf_files = glob.glob("*.pdf")

    if not pdf_files:
        raise FileNotFoundError(f"No portfolio knowledge PDF found in '{base_dir}' directory.")

    if len(pdf_files) == 1:
        return pdf_files[0]

    # If multiple exist, look for preferred filenames
    preferred = [p for p in pdf_files if "knowledge" in os.path.basename(p).lower() or "portfolio" in os.path.basename(p).lower()]
    if len(preferred) == 1:
        return preferred[0]

    raise ValueError(f"Multiple PDF files found in {base_dir}: {pdf_files}. Please specify one canonical knowledge PDF.")

def run_ingestion(full_reindex=False, commit_sha="local"):
    print("=" * 70)
    print("Single-Source PDF Portfolio Knowledge Base Ingestion Engine")
    print(f"Embedding Provider: Gemini ({EMBEDDING_MODEL}, {EMBEDDING_DIMENSION} dims)")
    print("=" * 70)

    pdf_path = find_canonical_pdf("images")
    pdf_filename = os.path.basename(pdf_path)
    print(f"Knowledge PDF Source: {pdf_path}")

    supabase = get_supabase_client()
    gemini_client = get_gemini_client()

    # Extract text and chunk PDF
    print("\n--- Extracting PDF Text & Preserving Page Structure ---")
    pages_data = extract_text_from_pdf(pdf_path)
    print(f"Successfully extracted {len(pages_data)} pages.")

    print("\n--- Performing Semantic Chunking & Metadata Tagging ---")
    chunks = chunk_pdf_pages(pages_data, pdf_filename)
    print(f"Generated {len(chunks)} semantic knowledge chunks.")

    # Fetch existing document hashes from Supabase metadata
    existing_hashes = {}
    try:
        res = supabase.table("documents").select("id, metadata, content").execute()
        if res.data:
            for row in res.data:
                meta = row.get("metadata") or {}
                c_hash = meta.get("content_hash")
                if c_hash:
                    existing_hashes[c_hash] = row
    except Exception as e:
        print(f"Notice querying existing database records: {e}")

    if full_reindex:
        print("\nNotice: Full re-index requested. Purging existing vector table...")
        try:
            supabase.table("documents").delete().neq("id", -1).execute()
        except Exception as e:
            print(f"Notice during table purge: {e}")
        existing_hashes = {}

    chunks_created = 0
    chunks_unchanged = 0
    chunks_deleted = 0
    current_chunk_hashes = set()

    print("\n--- Upserting Vector Embeddings into Supabase pgvector ---")
    for chunk in chunks:
        c_hash = chunk["content_hash"]
        current_chunk_hashes.add(c_hash)

        if c_hash in existing_hashes:
            chunks_unchanged += 1
        else:
            print(f"  [+] Embedding Chunk {chunk['chunk_index']} (Page {chunk['page']}): [{chunk['entity']}] - {chunk['section']}")
            emb = generate_embedding(chunk["content"], gemini_client)

            doc_metadata = {
                "source": chunk["source"],
                "source_type": chunk["source_type"],
                "page": chunk["page"],
                "section": chunk["section"],
                "subsection": chunk["subsection"],
                "entity": chunk["entity"],
                "entity_type": chunk["entity_type"],
                "chunk_index": chunk["chunk_index"],
                "content_hash": chunk["content_hash"],
                "title": chunk["title"],
                "commit_sha": commit_sha
            }

            doc_record = {
                "content": chunk["content"],
                "metadata": doc_metadata,
                "embedding": emb
            }

            try:
                supabase.table("documents").insert(doc_record).execute()
                chunks_created += 1
            except Exception as ex:
                print(f"  [!] Failed to insert chunk {chunk['chunk_index']} into Supabase: {ex}")

    # Remove stale chunks from previous PDF versions
    if existing_hashes and not full_reindex:
        stale_ids = []
        for c_hash, row in existing_hashes.items():
            if c_hash not in current_chunk_hashes:
                stale_ids.append(row["id"])

        if stale_ids:
            print(f"\n--- Purging {len(stale_ids)} Stale/Deleted Vector Chunks ---")
            for s_id in stale_ids:
                try:
                    supabase.table("documents").delete().eq("id", s_id).execute()
                    chunks_deleted += 1
                except Exception as e:
                    print(f"Notice deleting stale row {s_id}: {e}")

    print("\n" + "=" * 70)
    print("Ingestion Statistics Summary")
    print("=" * 70)
    print(f"Knowledge Source PDF: {pdf_filename}")
    print(f"Total Pages Processed:{len(pages_data)}")
    print(f"Total Semantic Chunks:{len(chunks)}")
    print(f"Unchanged (Skipped):  {chunks_unchanged}")
    print(f"New Chunks Embedded: {chunks_created}")
    print(f"Stale Chunks Deleted: {chunks_deleted}")
    print("=" * 70)
    print("PDF Knowledge Base Ingestion completed successfully.\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Portfolio PDF Knowledge Base Ingestion CLI")
    parser.add_argument("--full", action="store_true", help="Perform full re-index (purges existing vectors)")
    parser.add_argument("--incremental", action="store_true", help="Perform incremental sync (default)")
    parser.add_argument("--commit", type=str, default="local", help="Git commit SHA")
    args = parser.parse_args()

    run_ingestion(full_reindex=args.full, commit_sha=args.commit)
