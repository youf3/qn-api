from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Depends, status, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi_login import LoginManager
from fastapi.security import OAuth2PasswordRequestForm
from fastapi_login.exceptions import InvalidCredentialsException
from fastapi.openapi.utils import get_openapi
from common.config import Config
from api.router import router as APIRouter, client
from api.router import (
    get_topo,
    get_nodes,
    get_experiments,
    get_calibrations
)
from api.auth import get_user_db, authenticate_user, seed_admin_user
from quantnet_controller.common.constants import CalibrationType

import json
from pyvis import network as net
from networkx import node_link_graph

import uvicorn
import argparse

# Resolve asset directories relative to this file so the app works
# both when run from the repo root and when installed as a package.
_BASE_DIR = Path(__file__).resolve().parent

SECRET = 'make-me-secret-e63251d54ed0eab259d267c4eb9ebb24b9340fc3ff4ae73d'


@asynccontextmanager
async def lifespan(app):
    # Seed admin user on startup
    db = get_user_db()
    seed_admin_user(db)
    await client.openConnection()
    yield
    await client.closeConnection()


config = Config()
app = FastAPI(lifespan=lifespan)

app.include_router(APIRouter, prefix="/api", tags=["api"])
app.mount("/static", StaticFiles(directory=_BASE_DIR / "static"), name="static")

templates = Jinja2Templates(directory=_BASE_DIR / "templates")


class NotAuthenticatedException(Exception):
    pass


def exc_handler(request, exc):
    return RedirectResponse(url="/login")


manager = LoginManager(SECRET, token_url='/login', use_cookie=True,
                       not_authenticated_exception=NotAuthenticatedException)
app.add_exception_handler(NotAuthenticatedException, exc_handler)


@manager.user_loader()
def load_user(username: str):
    db = get_user_db()
    user = db.find_one({"username": username}, {"_id": 0, "password_hash": 0})
    return user


async def _get_topology():
    edge_style_map = {'quantum': {'color': 'blue', 'dashes': False},
                      'classic_clk': {'color': 'purple', 'dashes': True},
                      'classic_photon_gen': {'color': 'green', 'dashes': True},
                      'classic_bsm_result': {'color': 'brown', 'dashes': True},
                      'stabilization': {'color': 'teal'}}

    node_style_map = {'QNode': {'color': 'orange'},
                      'BSMNode': {'color': 'lightgreen'},
                      'MNode': {'color': 'grey'},
                      'OpticalSwitch': {'color': 'lightblue', 'mass': 10}}

    data = await get_topo()
    if isinstance(data, JSONResponse):
        raise RuntimeError("Topology request failed (controller unavailable)")
    data = data[0] if len(data) == 1 else data
    nxg = node_link_graph(data, edges="edges")
    g = net.Network(directed=True, cdn_resources='in_line')
    g.from_nx(nxg)
    for node in g.nodes:
        node['physics'] = True
        node.update(node_style_map.get(node['type']))
    for edge in g.edges:
        edge.update(edge_style_map.get(edge['title']))
    g.set_edge_smooth('dynamic')
    g.repulsion()
    return {
        "nodes": g.nodes,
        "edges": g.edges,
        "num_nodes": data.get("num_nodes"),
        "num_qubits": data.get("num_qubits"),
        "num_channels": data.get("num_channels")
    }


async def _dashboard(request: Request, user: dict):
    role = user.get("role", "user")
    payload = {"login": True,
               "user": user.get("email"),
               "username": user.get("username"),
               "role": role,
               "data": dict()}

    # Defaults so the dashboard always renders
    topo = {"nodes": [], "edges": [], "num_nodes": 0, "num_qubits": 0, "num_channels": 0}
    nodes = []
    experiments = []
    calibrations = []
    alert = None

    try:
        topo = await _get_topology()
        result = await get_nodes()
        nodes = result if not isinstance(result, JSONResponse) else nodes
        result = await get_experiments(request=True)
        experiments = result if not isinstance(result, JSONResponse) else experiments

        if role == "admin":
            result = await get_calibrations()
            calibrations = result if not isinstance(result, JSONResponse) else calibrations
        else:
            calibrations = []
            # Filter experiments to this user's only
            experiments = [e for e in experiments if e.get("owner") == user["username"]]
            # Extract node IDs from user's experiments
            user_nodes = set()
            for exp in experiments:
                params = exp.get("parameters", {})
                path_nodes = params.get("path", [])
                user_nodes.update(path_nodes)
            # Filter topology to user's nodes
            if user_nodes:
                topo["nodes"] = [n for n in topo["nodes"] if n.get("id") in user_nodes]
                topo["edges"] = [e for e in topo["edges"]
                                 if e.get("from") in user_nodes and e.get("to") in user_nodes]
            else:
                topo["nodes"] = []
                topo["edges"] = []
            topo["num_nodes"] = len(topo["nodes"])
            # Filter agent nodes
            nodes = [n for n in nodes
                     if n.get("systemSettings", {}).get("ID") in user_nodes]
    except Exception:
        import traceback
        traceback.print_exc()
        alert = "Controller not responding"

    payload.update({"data": {
        "topology": topo,
        "experiments": experiments,
        "nodes": nodes,
        "calibrations": calibrations,
        "cal_type_map": {m.value: m.label for m in CalibrationType},
        "request_types": config.request_types,
        "ws_host": config.mq_ws_host,
        "ws_port": config.mq_ws_port}
    })

    if alert:
        payload.update({"alert": alert})
    return templates.TemplateResponse(request=request, name="main.html", context=payload)


@app.get("/")
async def root(request: Request):
    try:
        user = await manager.get_current_user(request)
        if user:
            return RedirectResponse(url="/dashboard")
    except Exception:
        pass
    return RedirectResponse(url="/login")


@app.get("/login")
async def login_page(request: Request, error: int = 0):
    # If already logged in, redirect to dashboard
    try:
        user = await manager.get_current_user(request)
        if user:
            return RedirectResponse(url="/dashboard")
    except Exception:
        pass
    return templates.TemplateResponse(
        request=request, name="login.html", context={"error": error}
    )


@app.post("/login")
async def login(data: OAuth2PasswordRequestForm = Depends()):
    username = data.username
    password = data.password

    db = get_user_db()
    user = authenticate_user(db, username, password)
    if not user:
        return RedirectResponse(url="/login?error=1", status_code=status.HTTP_302_FOUND)

    access_token = manager.create_access_token(
        data=dict(sub=username)
    )
    resp = RedirectResponse(url="/dashboard", status_code=status.HTTP_302_FOUND)
    manager.set_cookie(resp, access_token)
    return resp


@app.get("/dashboard")
async def dashboard(request: Request, user=Depends(manager)):
    return await _dashboard(request, user)


@app.get("/admin/users")
async def admin_users_page(request: Request, user=Depends(manager)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return templates.TemplateResponse(
        request=request, name="admin_users.html",
        context={"login": True, "user": user.get("email"), "role": "admin"}
    )


@app.get("/logout")
async def logout(request: Request):
    response = RedirectResponse(url="/login")
    response.delete_cookie("access_token")
    return response


@app.get("/login_sso")
async def login_sso(request: Request):
    pass


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Quant-Net API",
        version="0.1.0",
        description="The web API that interfaces **Quant-Net Controller**.",
        routes=app.routes,
    )
    openapi_schema["info"]["x-logo"] = {
        "url": "https://fastapi.tiangolo.com/img/logo-margin/logo-teal.png"
    }
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi


def cli():
    """CLI entry point for the qn-api command."""
    parser = argparse.ArgumentParser(description="Run the Quant-Net API")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
    parser.add_argument("--port", type=int, default=8081, help="Port to bind")
    parser.add_argument(
        "--reload", action="store_true", default=False,
        help="Enable auto-reload on file changes (development only)"
    )
    args = parser.parse_args()
    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    cli()
