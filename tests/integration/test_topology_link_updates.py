"""Integration and regression tests for topology link/node state updates and frontend JS components."""
import asyncio
from pathlib import Path
import shutil
import subprocess
from unittest.mock import AsyncMock, patch

import pytest
import main


_REPO_ROOT = Path(__file__).resolve().parents[2]


def _make_sample_nx_topo():
    """Return a sample node-link topology payload matching quantnet_controller output."""
    return [{
        "directed": True,
        "multigraph": True,
        "graph": {},
        "nodes": [
            {"id": "QPU-1", "type": "MNode"},
            {"id": "BSM-1", "type": "BSMNode"},
            {"id": "SW-1", "type": "OpticalSwitch"},
        ],
        "edges": [
            {"source": "QPU-1", "target": "BSM-1", "key": 0, "title": "quantum"},
            {"source": "QPU-1", "target": "BSM-1", "key": 1, "title": "classical"},
            {"source": "BSM-1", "target": "SW-1", "key": 0, "title": "HeraldedConnection"},
        ],
        "num_nodes": 3,
        "num_qubits": 2,
        "num_channels": 3,
    }]


class TestTopologyLinkStateUpdates:
    """Test that topology link styling and disambiguation work across backend and frontend."""

    def test_apply_link_state_styling_quantum_and_classical(self):
        """Verify _apply_link_state_styling sets width, opacity, dashes, and color for all states."""
        q_edge = {"channel_type": "quantum", "base_color": "blue"}
        main._apply_link_state_styling(q_edge, "QUANTUM_UP")
        assert q_edge["width"] == 3
        assert q_edge["opacity"] == 1.0
        assert q_edge["dashes"] is False
        assert q_edge["color"] == "blue"

        main._apply_link_state_styling(q_edge, "CONTROL_UP")
        assert q_edge["width"] == 2
        assert q_edge["opacity"] == 1.0
        assert q_edge["dashes"] is False
        assert q_edge["color"] == "blue"

        main._apply_link_state_styling(q_edge, "INIT")
        assert q_edge["width"] == 1
        assert q_edge["opacity"] == 0.5
        assert q_edge["dashes"] == [5, 5]
        assert q_edge["color"] == "blue"

        main._apply_link_state_styling(q_edge, "DOWN")
        assert q_edge["width"] == 1
        assert q_edge["opacity"] == 0.3
        assert q_edge["dashes"] == [2, 4]
        assert q_edge["color"] == "#cccccc"

        c_edge = {"channel_type": "classical", "base_color": "purple"}
        main._apply_link_state_styling(c_edge, "CONTROL_UP")
        assert c_edge["width"] == 2
        assert c_edge["opacity"] == 1.0
        assert c_edge["dashes"] is False
        assert c_edge["color"] == "purple"

        main._apply_link_state_styling(c_edge, "DOWN")
        assert c_edge["color"] == "#cccccc"
        assert c_edge["dashes"] == [2, 4]

    def test_get_topology_disambiguates_parallel_quantum_and_classical_links(self):
        """Verify _get_topology classifies channel types strictly and does not mix parallel edges."""
        link_states = [
            {
                "src_cid": "QPU-1",
                "dst_cid": "BSM-1",
                "channel_id": "2",
                "is_quantum": True,
                "state": "QUANTUM_UP",
                "probe_tx_count": 5,
                "last_probe_info": {
                    "tof": 0.0125,
                    "vlink": "QPU-1:2->BSM-1:1",
                },
            },
            {
                "src_cid": "QPU-1",
                "dst_cid": "BSM-1",
                "channel_id": "quantum-named-control-ch",
                "is_quantum": False,
                "state": "CONTROL_UP",
                "last_probe_info": {"rtt_ms": 31.4},
            },
        ]
        with patch.object(main, "get_topo", AsyncMock(return_value=_make_sample_nx_topo())), \
                patch.object(main, "get_link_states", AsyncMock(return_value=link_states)):
            topo = asyncio.run(main._get_topology())

        q_edges = [
            e for e in topo["edges"]
            if e["from"] == "QPU-1" and e["to"] == "BSM-1" and e["channel_type"] == "quantum"
        ]
        c_edges = [
            e for e in topo["edges"]
            if e["from"] == "QPU-1" and e["to"] == "BSM-1" and e["channel_type"] == "classical"
        ]
        other_edges = [
            e for e in topo["edges"]
            if e["from"] == "BSM-1" and e["to"] == "SW-1"
        ]

        assert len(q_edges) == 1
        assert q_edges[0]["color"] == "blue"
        assert q_edges[0]["width"] == 3
        assert q_edges[0]["dashes"] is False
        assert q_edges[0]["title"] == "quantum (QUANTUM_UP) | Probes: 5 | ToF: 12.50ms | QPU-1:2->BSM-1:1"

        assert len(c_edges) == 1
        assert c_edges[0]["color"] == "purple"
        assert c_edges[0]["width"] == 2
        assert c_edges[0]["dashes"] is False
        assert c_edges[0]["title"] == "classical (CONTROL_UP)"

        # Non-'quantum' title ('HeraldedConnection') is classified strictly as 'classical'
        assert len(other_edges) == 1
        assert other_edges[0]["channel_type"] == "classical"
        assert other_edges[0]["base_color"] == "purple"
        assert other_edges[0]["color"] == "#cccccc"
        assert other_edges[0]["dashes"] == [2, 4]


class TestTopologyNodeStateUpdates:
    """Test that topology nodes are colored strictly by agent state and JS components pass."""

    def test_topology_nodes_start_grey_independent_of_node_type(self):
        """Verify _get_topology sets all nodes to grey initially regardless of node type."""
        with patch.object(main, "get_topo", AsyncMock(return_value=_make_sample_nx_topo())), \
                patch.object(main, "get_link_states", AsyncMock(return_value=[])):
            topo = asyncio.run(main._get_topology())

        nodes_by_id = {n["id"]: n for n in topo["nodes"]}
        assert nodes_by_id["QPU-1"]["color"] == "grey"
        assert nodes_by_id["BSM-1"]["color"] == "grey"
        assert nodes_by_id["SW-1"]["color"] == "grey"
        assert nodes_by_id["SW-1"]["mass"] == 10

    @pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for JS unit tests")
    def test_frontend_js_components_regression_suite(self):
        """Run the Node.js ES module regression test suite for frontend JS components."""
        js_test_file = _REPO_ROOT / "tests" / "js" / "frontend_regression.test.mjs"
        res = subprocess.run(
            ["node", "--test", str(js_test_file)],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert res.returncode == 0, f"Frontend JS regression tests failed:\n{res.stdout}\n{res.stderr}"
