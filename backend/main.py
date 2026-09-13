import dotenv
import uvicorn
import os

from server import app

dotenv.load_dotenv()


def main():
    uvicorn.run(app, port=int(os.getenv("PORT") or 8080), host="0.0.0.0")


if __name__ == "__main__":
    main()