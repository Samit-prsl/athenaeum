import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.embeddings import get_embeddings


def main() -> None:
    vector = get_embeddings().embed_query("warmup")
    print(f"Embedding model ready, dimension={len(vector)}")


if __name__ == "__main__":
    main()
