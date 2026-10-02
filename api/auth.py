"""
User authentication and management backed by MongoDB.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from passlib.hash import bcrypt
from pymongo import MongoClient
from pymongo.collection import Collection

from common.config import Config

logger = logging.getLogger(__name__)

_mongo_client: Optional[MongoClient] = None
_user_collection: Optional[Collection] = None


def get_user_db() -> Collection:
    """Return the MongoDB 'User' collection, creating the connection on first call."""
    global _mongo_client, _user_collection
    if _user_collection is None:
        config = Config()
        host = config.mq_mongo_host
        port = int(config.mq_mongo_port)
        _mongo_client = MongoClient(host, port)
        _user_collection = _mongo_client["quantnet"]["User"]
        # Ensure unique index on username
        _user_collection.create_index("username", unique=True)
    return _user_collection


def hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return bcrypt.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.verify(plain, hashed)


def seed_admin_user(db: Collection) -> None:
    """Create the default admin account if no users exist."""
    if db.count_documents({}) == 0:
        admin = {
            "username": "admin",
            "email": "quantnet@es.net",
            "password_hash": hash_password("admin"),
            "role": "admin",
            "created_at": datetime.now(timezone.utc).timestamp(),
        }
        db.insert_one(admin)
        logger.info("Seeded default admin user")


def authenticate_user(db: Collection, username: str, password: str) -> Optional[dict]:
    """Authenticate a user. Returns user dict (without password_hash) or None."""
    user = db.find_one({"username": username}, {"_id": 0})
    if user and verify_password(password, user["password_hash"]):
        result = {k: v for k, v in user.items() if k != "password_hash"}
        return result
    return None


def get_users(db: Collection) -> list:
    """Return all users without password hashes."""
    return list(db.find({}, {"_id": 0, "password_hash": 0}))


def create_user(db: Collection, username: str, email: str, password: str, role: str = "user") -> dict:
    """Create a new user. Raises ValueError if username exists."""
    if db.find_one({"username": username}):
        raise ValueError(f"User '{username}' already exists")
    if role not in ("admin", "user"):
        raise ValueError(f"Invalid role '{role}'. Must be 'admin' or 'user'")
    user = {
        "username": username,
        "email": email,
        "password_hash": hash_password(password),
        "role": role,
        "created_at": datetime.now(timezone.utc).timestamp(),
    }
    db.insert_one(user)
    return {k: v for k, v in user.items() if k not in ("password_hash", "_id")}


def delete_user(db: Collection, username: str) -> bool:
    """Delete a user by username. Returns True if deleted."""
    result = db.delete_one({"username": username})
    return result.deleted_count > 0
