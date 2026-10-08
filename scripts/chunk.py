import os
import re
import hashlib

def classify_entity_and_type(section_title, text_content):
    sec = section_title.upper()
    
    if "IDENTITY" in sec or "SUMMARY" in sec:
        return "Prince Singh", "person", "Identity & Summary", "Profile Overview"
    elif "EDUCATION" in sec:
        return "G.L. Bajaj Institute", "education", "Education", "Degree & Academic Timeline"
    elif "MASTER SKILLS" in sec or "PROGRAMMING" in sec:
        return "Technical Skills", "skill", "Master Skills", "Skill Inventory"
    elif "DATA SCIENCE" in sec or "ANALYTICS" in sec:
        return "Data Science & Analytics", "skill", "Data Science", "Analytics & ML"
    elif "WEB" in sec or "BACKEND" in sec:
        return "Web & Backend", "skill", "Web Development", "Backend Architecture"
    elif "DATABASE" in sec:
        return "Databases", "technology", "Databases", "Relational & NoSQL"
    elif "CLOUD" in sec or "DEVOPS" in sec:
        return "Cloud & DevOps", "technology", "Cloud Infrastructure", "DevOps & Data Engineering"
    elif "AI" in sec or "GENAI" in sec or "ML" in sec:
        return "AI & GenAI", "technology", "AI & Machine Learning", "Generative AI & LLMs"
    elif "PROJECT" in sec:
        m = re.search(r'P\d{2}\s*[\-—]\s*([^\n\:]+)', text_content)
        proj_name = m.group(1).strip() if m else "Portfolio Projects"
        return proj_name, "project", "Project Registry", proj_name
    elif "HACKATHON" in sec or "COMPETITIVE" in sec:
        return "Hackathons", "hackathon", "Hackathons & Contests", "Competition Builds"
    elif "ACHIEVEMENT" in sec:
        return "Achievements", "achievement", "Achievements", "Awards & Rankings"
    elif "CERTIFICATION" in sec:
        return "Certifications", "certification", "Certifications", "Consolidated Credentials"
    elif "EXPERIENCE" in sec:
        return "Practical Engineering", "experience", "Experience", "Engineering Practices"
    elif "LEADERSHIP" in sec or "COLLABORATION" in sec:
        return "Leadership", "experience", "Leadership & Teamwork", "Collaboration"
    elif "GITHUB" in sec or "OPEN SOURCE" in sec:
        return "GitHub Repositories", "technology", "GitHub", "Open Source Repositories"
    elif "LEETCODE" in sec or "CODECHEF" in sec or "HACKERRANK" in sec:
        return "Competitive Coding", "achievement", "Competitive Coding", "LeetCode & CodeChef"
    elif "INTEREST" in sec:
        return "Career Interests", "career", "Career Interests", "Engineering Specialization"
    elif "SOCIAL" in sec or "CONTACT" in sec or "LINK" in sec:
        return "Contact & Links", "other", "Social & Contact", "Verified Links"
    elif "FAQ" in sec:
        return "Frequently Asked Questions", "other", "FAQ", "General Questions"
    elif "RAG" in sec or "GROUNDING" in sec or "RULE" in sec:
        return "RAG Grounding Rules", "other", "System Rules", "Grounding Rules"
    else:
        return "Portfolio Knowledge", "other", section_title, "General Information"

def chunk_pdf_pages(pages_data, source_filename="prince-portfolio-knowledge.pdf"):
    """
    Performs semantic chunking on PDF text based on section headings.
    Ignores Page 2 (TOC table of contents lines) to avoid clutter chunks.
    """
    chunks = []
    chunk_index = 0

    # Match numbered section headings like "01. IDENTITY...", "02. EDUCATION...", "P01 — Swasthya...", "P02 — CourseMate..."
    # or standalone major headings.
    section_regex = re.compile(r'^(?:(?:\d{2}\.\s+[A-Z0-9\s\&\/—\-\:]+)|(?:P\d{2}\s+—\s+[^\n]+)|(?:[A-Z0-9\s\&\/—\-]{4,}:))$')

    current_header = "01. IDENTITY & PROFESSIONAL SUMMARY"
    current_chunk_lines = []
    current_page = 1

    for p in pages_data:
        page_num = p["page"]
        
        # Skip Page 2 TOC (Table of Contents index list)
        if page_num == 2 and "CONTENTS" in p["text"]:
            continue

        lines = p["text"].split("\n")
        for line in lines:
            line_str = line.strip()
            if not line_str:
                continue

            # Check if this line is a section header
            if section_regex.match(line_str) and len(line_str) > 4 and not line_str.startswith("Page "):
                # Flush previous chunk if exists
                if current_chunk_lines:
                    content = "\n".join(current_chunk_lines).strip()
                    if len(content) >= 30:
                        entity, entity_type, section_name, subsection_name = classify_entity_and_type(current_header, content)
                        c_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                        chunks.append({
                            "source": source_filename,
                            "source_type": "portfolio_knowledge",
                            "page": current_page,
                            "section": section_name,
                            "subsection": subsection_name,
                            "entity": entity,
                            "entity_type": entity_type,
                            "chunk_index": chunk_index,
                            "content_hash": c_hash,
                            "content": content,
                            "title": f"Portfolio Knowledge — {entity}"
                        })
                        chunk_index += 1
                    current_chunk_lines = []

                current_header = line_str
                current_page = page_num
                current_chunk_lines.append(line_str)
            else:
                current_chunk_lines.append(line_str)

                # Split chunks if length exceeds ~1000 characters
                if len("\n".join(current_chunk_lines)) > 1000:
                    content = "\n".join(current_chunk_lines).strip()
                    if len(content) >= 30:
                        entity, entity_type, section_name, subsection_name = classify_entity_and_type(current_header, content)
                        c_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                        chunks.append({
                            "source": source_filename,
                            "source_type": "portfolio_knowledge",
                            "page": current_page,
                            "section": section_name,
                            "subsection": subsection_name,
                            "entity": entity,
                            "entity_type": entity_type,
                            "chunk_index": chunk_index,
                            "content_hash": c_hash,
                            "content": content,
                            "title": f"Portfolio Knowledge — {entity}"
                        })
                        chunk_index += 1
                    current_chunk_lines = []

    # Final flush
    if current_chunk_lines:
        content = "\n".join(current_chunk_lines).strip()
        if len(content) >= 30:
            entity, entity_type, section_name, subsection_name = classify_entity_and_type(current_header, content)
            c_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            chunks.append({
                "source": source_filename,
                "source_type": "portfolio_knowledge",
                "page": current_page,
                "section": section_name,
                "subsection": subsection_name,
                "entity": entity,
                "entity_type": entity_type,
                "chunk_index": chunk_index,
                "content_hash": c_hash,
                "content": content,
                "title": f"Portfolio Knowledge — {entity}"
            })
            chunk_index += 1

    return chunks
