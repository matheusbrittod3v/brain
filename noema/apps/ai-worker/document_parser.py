import base64
import binascii
import tempfile
from pathlib import Path
from typing import Any

MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".csv"}


def parse_document_upload(
    file_name: str,
    content_base64: str,
    converter: Any = None,
    fallback_converter: Any = None,
) -> tuple[str, str]:
    """Convert bounded upload bytes with Docling without exposing host paths."""
    if not file_name or file_name != file_name.strip() or any(char in file_name for char in ("/", "\\", "\x00")):
        raise ValueError("file_name must be a plain filename without path separators")
    extension = Path(file_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("unsupported document extension")
    if not content_base64 or not isinstance(content_base64, str):
        raise ValueError("content_base64 must be a non-empty base64 string")
    max_encoded_size = 4 * ((MAX_DOCUMENT_BYTES + 2) // 3)
    if len(content_base64) > max_encoded_size:
        raise ValueError("document exceeds the 16 MiB limit")
    try:
        content = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("content_base64 is invalid") from error
    if not content:
        raise ValueError("document is empty")
    if len(content) > MAX_DOCUMENT_BYTES:
        raise ValueError("document exceeds the 16 MiB limit")

    if converter is None and fallback_converter is None:
        try:
            from docling.document_converter import DocumentConverter
            converter = DocumentConverter()
        except Exception as error:
            raise RuntimeError("Docling is unavailable") from error

    with tempfile.TemporaryDirectory(prefix="noema-docling-") as temporary_directory:
        temporary_file = Path(temporary_directory) / f"upload{extension}"
        temporary_file.write_bytes(content)
        errors: list[Exception] = []
        if converter is not None:
            try:
                converted = converter.convert(str(temporary_file), max_file_size=MAX_DOCUMENT_BYTES)
                markdown = converted.document.export_to_markdown()
                if not isinstance(markdown, str) or not markdown.strip():
                    raise ValueError("Docling returned an empty document")
                return markdown, "docling"
            except Exception as error:
                errors.append(error)
        if fallback_converter is not None:
            try:
                converted = fallback_converter.convert(str(temporary_file))
                markdown = getattr(converted, "markdown", None)
                if not isinstance(markdown, str):
                    markdown = getattr(converted, "text_content", None)
                if not isinstance(markdown, str) or not markdown.strip():
                    raise ValueError("MarkItDown returned an empty document")
                return markdown, "markitdown"
            except Exception as error:
                errors.append(error)
        if errors:
            raise RuntimeError("All document parsers failed") from errors[-1]
        raise RuntimeError("No document parser is available")
