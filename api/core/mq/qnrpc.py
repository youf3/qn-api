from common.config import Config
from common import constants as CONSTANT
from quantnet_mq.rpcclient import RPCClient
from quantnet_mq.schema.models import Schema
import asyncio
import uvloop
import json
import uuid
import logging

logger = logging.getLogger(__name__)

# Default RPC timeout in seconds
DEFAULT_TIMEOUT = 10.0


class QuantNetClient(object):
    def __init__(self, config):
        self.client = RPCClient(f"quant-net-api-{uuid.uuid4().hex}",
                                host=config.mq_broker_host,
                                port=config.mq_broker_port)

        if config.schema_path:
            Schema.load_schema(config.schema_path)
        print(f"QN Client started with protocol namespaces:\n{Schema()}")

        handlers = [
            ('getinfo', None, 'quantnet_mq.schema.models.getInfo'),
            ('calibrate', None, 'quantnet_mq.schema.models.agentCalibration'),
            ('getnode', None, 'quantnet_mq.schema.models.getNode'),
            ('pingpong', None, 'quantnet_mq.schema.models.pingpong.pingPongRequest'),
            ('bsmRequest', None, 'quantnet_mq.schema.models.bsm.bsmRequest'),
            ('spgRequest', None, 'quantnet_mq.schema.models.spg.spgRequest'),
            ('egpRequest', None, 'quantnet_mq.schema.models.egp.egpRequest'),
            ('simulate', None, 'quantnet_mq.schema.models.agentSimulation'),
            ('agentExperiment', None, 'quantnet_mq.schema.models.agentExperiment'),
            ('getTasks', None, 'quantnet_mq.schema.models.agentMonitorTask'),
        ]
        for rh in handlers:
            self.client.set_handler(rh[0], rh[1], rh[2])

    # ── Connection lifecycle ─────────────────────────────────────────────

    async def openConnection(self):
        try:
            await self.client.start()
        except Exception as e:
            raise e

    async def closeConnection(self):
        try:
            await self.client.stop()
        except Exception as e:
            raise e

    # ── Centralised RPC call ─────────────────────────────────────────────

    async def _call(self, handler, payload, *,
                    timeout=DEFAULT_TIMEOUT,
                    result_key=None):
        """
        Single point of invocation for all RPC calls.

        Parameters
        ----------
        handler : str
            The RPC handler name registered in __init__.
        payload : dict
            The message payload to send.
        timeout : float, optional
            Seconds to wait before raising TimeoutError.
            Defaults to DEFAULT_TIMEOUT (30 s).
        result_key : str or None, optional
            If provided, extract this key from the parsed JSON response
            and return its value (defaulting to an empty list if missing).
            If None, return the full parsed dict.

        Returns
        -------
        dict | list
            Parsed JSON response, optionally narrowed to *result_key*.

        Raises
        ------
        TimeoutError
            If the RPC call exceeds *timeout*.
        json.JSONDecodeError
            If the response is not valid JSON.
        Exception
            Any other transport-level error from the RPC client.
        """
        logger.debug("RPC _call: handler=%s payload=%s timeout=%s result_key=%s",
                      handler, payload, timeout, result_key)
        raw = await self.client.call(handler, payload, timeout=timeout)
        data = json.loads(raw)

        if result_key is not None:
            return data.get(result_key, [])
        return data

    # ── Public API methods ───────────────────────────────────────────────

    async def getInfo(self, info, full: bool = False):
        if info['type'] == CONSTANT.InfoType.TOPO:
            payload = {
                "type": "topology",
                "parameters": {
                    "full": full
                }
            }
        else:
            raise Exception(f"Not defined info type {info}")

        return await self._call("getinfo", payload, result_key="value")

    async def calibrate(self,
                        type: int,
                        src: str = None, dst: str = None,
                        power: str = None, light: str = None,
                        calid: str = None):

        payload = {
            "type": "calibrate",
            "parameters": {
                "type": type,
                "src": src,
                "dst": dst,
                "power": power,
                "cal_light": light
            }} if not calid else {
            "type": "calibration",
            "parameters": {
                "id": calid
            }
        }

        return await self._call("calibrate", payload)

    async def getCalibration(self,
                             src: str = None, dst: str = None,
                             calid: str = None,
                             last: bool = False):

        if last:
            payload = {
                "type": "getLast",
                "parameters": {
                    "id": calid if calid else None,
                    "src": src if src else None,
                    "dst": dst if dst else None
                }
            }
        elif calid:
            payload = {
                "type": "get",
                "parameters": {
                    "id": calid
                }
            }
        elif src and dst:
            payload = {
                "type": "get",
                "parameters": {
                    "src": src,
                    "dst": dst
                }
            }
        elif (src and not dst) or (not src and dst):
            raise Exception("Invalid parameters for getCalibration")
        else:
            payload = {
                "type": "get",
                "parameters": {
                }
            }

        return await self._call("calibrate", payload, result_key="calibrations")

    async def pingpong(self, request):
        return await self._call("pingpong", request, timeout=60.0)

    async def getNode(self, ID: str = None):
        if ID is None:
            payload = {
                "type": "node",
                "parameters": {}
            }
        else:
            payload = {
                "type": "node",
                "parameters": {
                    "systemSettings.ID": ID
                }
            }

        return await self._call("getinfo", payload)

    async def getExperiment(self, ID: str = None, last: bool = False,
                            request: bool = False, agent_id: str = None):
        agent_ids = [agent_id] if agent_id else ["query"]
        params = {
            "agentIds": agent_ids,
            "expName": "query",
            "expParameters": []
        }
        if ID is not None:
            params["id"] = ID

        payload = {"type": "get", "parameters": params}
        logger.info("RPC getExperiment: %s", payload)

        exps = await self._call("agentExperiment", payload,
                                result_key="experiments")

        if last and exps:
            exps = [exps[0]]

        return exps

    async def getAgentTask(self, agent_id: str = None):
        payload = {"agent_id": agent_id}
        return await self._call("getTasks", payload, result_key="tasks")

    async def simulate(self, name, agent, params):
        payload = {
            "type": "simulate",
            "parameters": {
                "name": name,
                "agent": agent,
                "params": params
            }
        }
        return await self._call("simulate", payload)

    async def runSimpleLink(self, src, dst, protocol, params):
        payload = {
            "type": "simulate",
            "parameters": {
                "name": "simplelink",
                "src": src,
                "dst": dst,
                "protocol": protocol,
                "params": params
            }
        }
        return await self._call("simulate", payload)

    async def bsmExperiment(self, nodes, rate, duration, owner=None):
        payload = {
            "nodes": nodes,
            "rate": rate,
            "duration": duration
        }
        if owner:
            payload["owner"] = owner
        return await self._call("bsmRequest", payload)

    async def singlePhotonGeneration(self, nodes, rate, duration, owner=None):
        payload = {
            "nodes": nodes,
            "rate": rate,
            "duration": duration
        }
        if owner:
            payload["owner"] = owner
        return await self._call("spgRequest", payload)

    async def entanglementGeneration(self, src, dst, pairs, bellState, fidelity, owner=None):
        payload = {
            "source": src,
            "destination": dst,
            "pairs": pairs,
            "bellState": bellState,
            "fidelity": fidelity
        }
        if owner:
            payload["owner"] = owner
        return await self._call("egpRequest", payload)


if __name__ == '__main__':

    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    config = Config(
        mq_broker_host="127.0.0.1",
        mq_broker_port=1883,
    )
    client = MQTTClient(config=config)
    asyncio.run(client.getNode())
