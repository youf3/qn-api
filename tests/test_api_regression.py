"""Backend and template regression tests for qn-api."""
import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.responses import JSONResponse
from starlette.requests import Request

import main
from api import router as api_router
from api.core import linkstate as linkstate_mod


_REPO_ROOT = Path(__file__).resolve().parents[1]


def _make_dummy_request(path: str = "/dashboard") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": [],
        "query_string": b"",
        "app": main.app,
        "router": main.app.router,
    }
    return Request(scope)


def _make_topo_payload():
    return [{
        "directed": True,
        "multigraph": False,
        "graph": {},
        "nodes": [
            {"id": "QPU-1", "type": "MNode"},
            {"id": "QPU-2", "type": "MNode"},
            {"id": "BSM-1", "type": "BSMNode"},
        ],
        "edges": [
            {"source": "QPU-1", "target": "BSM-1", "title": "quantum"},
            {"source": "QPU-2", "target": "BSM-1", "title": "quantum"},
        ],
        "num_nodes": 3,
        "num_qubits": 4,
        "num_channels": 2,
    }]


class TestTopologyStateRankingAndErrors:
    """Regression tests for _get_topology state ranking and error handling."""

    def test_get_topology_picks_highest_ranked_state_for_same_edge_type(self):
        """When multiple channels of the same type exist between two nodes, highest rank wins."""
        link_states = [
            {
                "src_cid": "QPU-1",
                "dst_cid": "BSM-1",
                "channel_id": "q1",
                "is_quantum": True,
                "state": "DOWN",
            },
            {
                "src_cid": "QPU-1",
                "dst_cid": "BSM-1",
                "channel_id": "q2",
                "is_quantum": True,
                "state": "QUANTUM_UP",
            },
            {
                "src_cid": "QPU-1",
                "dst_cid": "BSM-1",
                "channel_id": "q3",
                "is_quantum": True,
                "state": "INIT",
            },
        ]
        with patch.object(main, "get_topo", AsyncMock(return_value=_make_topo_payload())), \
                patch.object(main, "get_link_states", AsyncMock(return_value=link_states)):
            topo = asyncio.run(main._get_topology())

        edge = next(e for e in topo["edges"] if e["from"] == "QPU-1" and e["to"] == "BSM-1")
        assert edge["width"] == 3
        assert edge["color"] == "blue"
        assert edge["dashes"] is False
        assert "QUANTUM_UP" in edge["title"]

    def test_get_topology_raises_when_controller_unavailable(self):
        """When get_topo returns a JSONResponse error, _get_topology raises RuntimeError."""
        err_resp = JSONResponse(status_code=504, content={"error": "Request timed out"})
        with patch.object(main, "get_topo", AsyncMock(return_value=err_resp)):
            try:
                asyncio.run(main._get_topology())
                assert False, "Expected RuntimeError when controller is unavailable"
            except RuntimeError as exc:
                assert "Topology request failed" in str(exc)


class TestDashboardRenderingAndFiltering:
    """Regression tests for _dashboard node coloring, RBAC filtering, and controller failure fallback."""

    def test_dashboard_colors_nodes_by_agent_state(self):
        """Verify _dashboard maps IN_SPEC -> #32CD32, OUT_OF_SPEC -> #FF0000, and other states -> grey."""
        nodes_payload = [
            {"systemSettings": {"ID": "QPU-1"}, "state": {"value": "IN_SPEC"}},
            {"systemSettings": {"ID": "QPU-2"}, "state": {"value": "OUT_OF_SPEC"}},
            {"systemSettings": {"ID": "BSM-1"}, "state": {"value": "CALIBRATING"}},
        ]
        with patch.object(main, "get_topo", AsyncMock(return_value=_make_topo_payload())), \
                patch.object(main, "get_link_states", AsyncMock(return_value=[])), \
                patch.object(main, "get_nodes", AsyncMock(return_value=nodes_payload)), \
                patch.object(main, "get_experiments", AsyncMock(return_value=[])), \
                patch.object(main, "get_calibrations", AsyncMock(return_value=[])):
            resp = asyncio.run(
                main._dashboard(_make_dummy_request(), {"username": "admin", "email": "a@b.c", "role": "admin"})
            )

        topo_nodes = {n["id"]: n for n in resp.context["data"]["topology"]["nodes"]}
        assert topo_nodes["QPU-1"]["color"] == "#32CD32"
        assert topo_nodes["QPU-2"]["color"] == "#FF0000"
        assert topo_nodes["BSM-1"]["color"] == "grey"

    def test_dashboard_non_admin_filters_topology_and_link_states(self):
        """Verify non-admin users only see nodes, edges, and link_states along their experiment paths."""
        nodes_payload = [
            {"systemSettings": {"ID": "QPU-1"}, "state": {"value": "IN_SPEC"}},
            {"systemSettings": {"ID": "QPU-2"}, "state": {"value": "IN_SPEC"}},
            {"systemSettings": {"ID": "BSM-1"}, "state": {"value": "IN_SPEC"}},
        ]
        experiments_payload = [
            {"owner": "alice", "parameters": {"path": ["QPU-1", "BSM-1"]}},
            {"owner": "bob", "parameters": {"path": ["QPU-2", "BSM-1"]}},
        ]
        link_states_payload = [
            {"src_cid": "QPU-1", "dst_cid": "BSM-1", "channel_id": "1", "state": "QUANTUM_UP"},
            {"src_cid": "QPU-2", "dst_cid": "BSM-1", "channel_id": "2", "state": "QUANTUM_UP"},
        ]
        with patch.object(main, "get_topo", AsyncMock(return_value=_make_topo_payload())), \
                patch.object(main, "get_link_states", AsyncMock(return_value=link_states_payload)), \
                patch.object(main, "get_nodes", AsyncMock(return_value=nodes_payload)), \
                patch.object(main, "get_experiments", AsyncMock(return_value=experiments_payload)):
            resp = asyncio.run(
                main._dashboard(_make_dummy_request(), {"username": "alice", "email": "alice@es.net", "role": "user"})
            )

        data = resp.context["data"]
        node_ids = {n["id"] for n in data["topology"]["nodes"]}
        assert node_ids == {"QPU-1", "BSM-1"}
        assert len(data["topology"]["edges"]) == 1
        assert data["topology"]["edges"][0]["from"] == "QPU-1"
        assert len(data["link_states"]) == 1
        assert data["link_states"][0]["src_cid"] == "QPU-1"

    def test_dashboard_sets_alert_when_controller_not_responding(self):
        """Verify _dashboard degrades gracefully and sets alert when _get_topology fails."""
        err_resp = JSONResponse(status_code=504, content={"error": "Timeout"})
        with patch.object(main, "get_topo", AsyncMock(return_value=err_resp)):
            resp = asyncio.run(
                main._dashboard(_make_dummy_request(), {"username": "admin", "email": "a@b.c", "role": "admin"})
            )

        assert resp.context.get("alert") == "Controller not responding"
        assert resp.context["data"]["topology"]["nodes"] == []


class TestRouterAndLinkStateUtilities:
    """Regression tests for api.router._rpc_request, /api/link_states, and get_link_states."""

    def test_rpc_request_timeout_and_generic_error(self):
        """Verify _rpc_request maps TimeoutError -> 504 and generic Exception -> 502."""
        async def _raise_timeout():
            raise TimeoutError("timed out")

        async def _raise_runtime():
            raise RuntimeError("broker down")

        resp_504 = asyncio.run(api_router._rpc_request(_raise_timeout(), operation="Fetch node"))
        assert isinstance(resp_504, JSONResponse)
        assert resp_504.status_code == 504
        assert json.loads(resp_504.body)["error"] == "Request timed out"

        resp_502 = asyncio.run(api_router._rpc_request(_raise_runtime(), operation="Fetch node"))
        assert isinstance(resp_502, JSONResponse)
        assert resp_502.status_code == 502
        assert json.loads(resp_502.body)["error"] == "Service unavailable"

    def test_get_link_states_returns_docs_or_empty_list_on_exception(self):
        """Verify get_link_states queries DBmodel.LinkState and falls back to [] on error."""
        sample_docs = [{"src_cid": "QPU-1", "dst_cid": "BSM-1", "state": "QUANTUM_UP"}]
        mock_handler = MagicMock()
        mock_handler.find = AsyncMock(return_value=sample_docs)
        mock_db = MagicMock()
        mock_db.handler.return_value = mock_handler

        with patch.object(linkstate_mod, "init_async_broker_config"), \
                patch.object(linkstate_mod, "init_async_collection_config"), \
                patch.object(linkstate_mod, "AsyncAbstractDatabase", return_value=mock_db):
            res = asyncio.run(linkstate_mod.get_link_states())
            assert res == sample_docs

        with patch.object(linkstate_mod, "init_async_broker_config", side_effect=RuntimeError("db down")):
            res_err = asyncio.run(linkstate_mod.get_link_states())
            assert res_err == []


class TestMainHtmlTemplateConventions:
    """Regression tests verifying legend line styles and combined probe measurement headers in main.html."""

    def test_main_html_legend_and_probe_headers(self):
        """Ensure main.html preserves accurate topology legend styles and unified Latency column headers."""
        html = (_REPO_ROOT / "templates" / "main.html").read_text(encoding="utf-8")

        # Topology legend line styles: Quantum (3px solid blue), Classical (2px solid purple),
        # QUANTUM_UP (3px solid blue), CONTROL_UP (2px solid purple), INIT (1px dashed #666), DOWN (1px dotted #aaa)
        assert "border-top:3px solid blue;" in html
        assert "Quantum" in html
        assert "QUANTUM_UP" in html
        assert "border-top:2px solid purple;" in html
        assert "Classical" in html
        assert "CONTROL_UP" in html
        assert "border-top:1px dashed #666;" in html
        assert "INIT" in html
        assert "border-top:1px dotted #aaa;" in html
        assert "DOWN" in html

        # Node state legend colors: IN_SPEC (#32CD32), OUT_OF_SPEC (#FF0000), UNKNOWN (grey)
        assert "color: #32CD32;" in html
        assert "IN_SPEC" in html
        assert "color: #FF0000;" in html
        assert "OUT_OF_SPEC" in html
        assert "color: grey;" in html

        # Probe status tables use single unified Latency / Latency (Photons) column headers
        assert "<th>Latency</th>" in html
        assert "<th>Latency (Photons)</th>" in html
