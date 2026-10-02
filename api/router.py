import logging
import uuid
from fastapi import Query, APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Optional, Union
from enum import Enum
from pydantic import BaseModel
from common.config import Config
from common import constants as CONSTANT
from .core.mq.qnrpc import QuantNetClient
from api.auth import get_user_db, get_users, create_user, delete_user

logger = logging.getLogger(__name__)

client = QuantNetClient(Config())
router = APIRouter()


# ── Pydantic models ─────────────────────────────────────────────────────

class Time(BaseModel):
    ts: float
    date: str


class Device(BaseModel):
    name: str
    value: float
    is_active: Union[bool, None] = None


class LightSignal(Enum):
    H = "H"
    D = "D"


class Simulation(Enum):
    simple = "simple_link"
    quantnet = "quantnet"


class SimulationParams(BaseModel):
    distance: float
    numQubits: int


class Status(BaseModel):
    code: int
    value: str


class Experiment(BaseModel):
    id: str
    type: str
    status: Status
    result: Union[dict, None] = None
    created_at: float
    updated_at: float
    phase: Optional[str] = None
    agentIds: Optional[List[str]] = None
    expName: Union[str, None] = None
    is_local: bool = False
    parameters: Union[dict, None] = None
    error: Union[str, None] = None


# ── Centralised error handling ───────────────────────────────────────────

async def _rpc_request(coro, *, operation: str = "RPC request", context: str = ""):
    """
    Execute an RPC coroutine with unified error handling.

    Parameters
    ----------
    coro : awaitable
        The already-constructed coroutine to await (e.g. ``client.getNode(ID)``).
    operation : str
        Human-readable name of the operation (used in error messages).
    context : str
        Additional context for log messages (e.g. parameter values).

    Returns
    -------
    The result of the coroutine on success, or a JSONResponse on failure.
    """
    try:
        return await coro
    except TimeoutError:
        logger.error("Timeout: %s %s", operation, context)
        return JSONResponse(
            status_code=504,
            content={
                "error": "Request timed out",
                "detail": f"{operation} did not complete in time."
            }
        )
    except Exception as e:
        logger.exception("Error: %s %s", operation, context)
        return JSONResponse(
            status_code=502,
            content={
                "error": "Service unavailable",
                "detail": str(e)
            }
        )


# ── Endpoints ────────────────────────────────────────────────────────────

@router.get("/node")
@router.get("/node/{ID}", summary="Get node information", tags=["Nodes"])
async def get_nodes(ID: str = None):
    """
    Get the information of the given node
    - **ID**: the node id, e.g. "LBNL-Q". If blank, return all nodes
    """
    ret = await _rpc_request(
        client.getNode(ID),
        operation="Fetch node info",
        context=f"ID={ID}"
    )
    if isinstance(ret, JSONResponse):
        return ret
    return ret.get("value", list())


@router.get("/topology", summary="Get topology", tags=["Nodes"])
async def get_topo(full: bool = False):
    """
    Get the topology
    """
    return await _rpc_request(
        client.getInfo(info={"type": CONSTANT.InfoType.TOPO}, full=full),
        operation="Fetch topology"
    )


@router.post("/pingpong", summary="Send pings to a list of remotes", tags=["PingPong"])
async def pingpong(remotes: List[str] = Query(None), iterations: int = 5):
    """
    Send pings to a list of remotes
    - **remotes**: the name list of remote nodes
    """
    request = {'type': 'ping', 'destinations': remotes, 'iterations': iterations,
               'token': uuid.uuid4().hex}
    return await _rpc_request(
        client.pingpong(request),
        operation="Ping",
        context=f"remotes={remotes}"
    )


@router.post("/calibrate", summary="Run a calibration process", tags=["Calibrations"])
async def calibrate(type: int, src: str, dst: str, power: float, light: str):
    """
    Run a calibration process with all the information
    - **src**: the name of source agent
    - **dst**: the name of destination agent
    - **power**: the power in W (watt), e.g. "0.1"
    - **light**: light signal, either "D" or "H"
    """
    return await _rpc_request(
        client.calibrate(type=type, src=src, dst=dst, power=power, light=light),
        operation="Calibration",
        context=f"src={src} dst={dst}"
    )


@router.get("/calibration")
@router.get("/calibration/{calid}", summary="Get calibration information", tags=["Calibrations"])
async def get_calibrations(calid: str = None, last: bool = False):
    """
    Get the information of the given calibration, latest one or all calibrations
    - **calid**: the calibration id, e.g. "6cc93232d75f4f08b598a9d4f6f5bf10". If blank, return all calibrations
    - **last**: if true, get the latest calibration
    """
    return await _rpc_request(
        client.getCalibration(calid=calid, last=last),
        operation="Fetch calibration",
        context=f"calid={calid}"
    )


@router.get("/experiments", response_model=List[Experiment], tags=["Experiments"])
@router.get("/experiments/{expid}", response_model=List[Experiment], summary="Get experiment information", tags=["Experiments"])
async def get_experiments(
    expid: str = None,
    last: bool = False,
    request: bool = False,
    agent_id: str = None
):
    """
    Get the information of the given experiment, latest one or all experiments
    - **expid**: the experiment id. If blank, return all experiments
    - **last**: if true, get the latest experiment
    - **request**: if true, return the original request instead of the experiment
    - **agent_id**: the agent id to filter experiments by
    """
    return await _rpc_request(
        client.getExperiment(ID=expid, last=last, request=request, agent_id=agent_id),
        operation="Fetch experiments",
        context=f"expid={expid}"
    )


@router.get("/tasks", summary="Get agent task results", tags=["Tasks"])
async def get_tasks(agent_id: str = None):
    """
    Get the local task results (calibrations)
    - **agent_id**: the agent id to filter tasks by
    """
    return await _rpc_request(
        client.getAgentTask(agent_id=agent_id),
        operation="Fetch tasks",
        context=f"agent_id={agent_id}"
    )


@router.post("/bsm")
async def bsm(src: List[str] = Query(None), rate: float = 10, duration: float = 120):
    return await _rpc_request(
        client.bsmExperiment(nodes=src, rate=rate, duration=duration),
        operation="BSM experiment",
        context=f"src={src}"
    )


@router.post("/spg")
async def spg(src: List[str] = Query(None), rate: float = 10, duration: float = 120):
    return await _rpc_request(
        client.singlePhotonGeneration(nodes=src, rate=rate, duration=duration),
        operation="Single photon generation",
        context=f"src={src}"
    )


@router.post("/egp")
async def egp(src: str, dst: str, pairs: int, bellState: str, fidelity: float):
    return await _rpc_request(
        client.entanglementGeneration(src=src, dst=dst, pairs=pairs,
                                      bellState=bellState, fidelity=fidelity),
        operation="Entanglement generation",
        context=f"src={src} dst={dst}"
    )


# ── User Management ──────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    username: str
    email: str
    password: str
    role: str = "user"


@router.get("/users", summary="List all users", tags=["Users"])
async def list_users():
    """List all users (admin only — enforced at the route level in main.py)."""
    db = get_user_db()
    return get_users(db)


@router.post("/users", summary="Create a user", tags=["Users"])
async def add_user(body: CreateUserRequest):
    """Create a new user (admin only — enforced at the route level in main.py)."""
    db = get_user_db()
    try:
        return create_user(db, body.username, body.email, body.password, body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/users/{username}", summary="Delete a user", tags=["Users"])
async def remove_user(username: str):
    """Delete a user (admin only — enforced at the route level in main.py)."""
    db = get_user_db()
    if not delete_user(db, username):
        raise HTTPException(status_code=404, detail=f"User '{username}' not found")
    return {"detail": f"User '{username}' deleted"}
