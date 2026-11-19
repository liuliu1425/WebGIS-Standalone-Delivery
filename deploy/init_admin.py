"""Initialize the first administrator in this deployment's empty account store."""
import os
from pathlib import Path
import sys

def main():
    sys.path.insert(0, str(Path.cwd()))
    from app.services.user_repository import get_user_repository

    repository = get_user_repository()
    if repository.count_users():
        print("Existing deployment accounts preserved.")
        return
    username = os.environ.get("BACKEND_ADMIN_USERNAME", "").strip()
    password = os.environ.get("BACKEND_ADMIN_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("Create the private deployment configuration before starting")
    repository.create_user(username=username, password=password, role="admin")
    print("Initialized the first deployment administrator.")

if __name__ == "__main__":
    main()
