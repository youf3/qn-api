"""Link state query utilities."""
import logging
from quantnet_controller.core.abstractdatabase import (
    AsyncAbstractDatabase, DBmodel
)
from quantnet_controller.db.async_broker import (
    init_async_broker_config
)
from quantnet_controller.db.nosql.collection.async_collection import (
    init_async_collection_config
)
from common.config import Config

logger = logging.getLogger(__name__)


async def get_link_states() -> list:
    """
    Query the LinkState MongoDB collection and return all documents.

    Returns list of dicts with keys: src_cid, dst_cid, channel_id,
    state, timestamp. If collection is empty or unreachable,
    returns empty list.
    """
    try:
        # Initialize async broker config if not already done
        config = Config()
        init_async_broker_config(config)
        init_async_collection_config(config)

        # Get the link state collection handler
        db = AsyncAbstractDatabase()
        link_db = db.handler(DBmodel.LinkState)

        # Query all documents
        docs = await link_db.find()
        return docs if docs else []
    except Exception as e:
        logger.warning(f"Failed to fetch link states: {e}")
        return []
