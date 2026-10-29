"""
Get the confiugration file from /opt/quantnet/etc/quantapi.cfg
"""

import os
import logging

try:
    import ConfigParser
except ImportError:
    import configparser as ConfigParser

log = logging.getLogger(__name__)


def config_get(section, option, raise_exception=True, default=None, check_config_table=True):
    """
        Return the string value for a given option in a section

        :param section: the named section.
        :param option: the named option.
        :param raise_exception: Boolean to raise or not NoOptionError or NoSectionError.
        :param default: the default value if not found.
        :param check_config_table: if not set, avoid looking at config table
    .
        :returns: the configuration value.
    """
    try:
        return __CONFIG.get(section, option)
    except (ConfigParser.NoOptionError, ConfigParser.NoSectionError) as err:
        if raise_exception and default is None:
            raise err
        return default


__CONFIG = ConfigParser.ConfigParser(os.environ)

__CONFIGFILES = list()
for i in ["QUANTNET_HOME", "VIRTUAL_ENV"]:
    if i in os.environ:
        __CONFIGFILES.append(f"{os.environ[i]}/etc/quantnet.cfg")
        __CONFIGFILES.append(f"{os.environ[i]}/conf/quantnet.cfg")
__CONFIGFILES.append("/opt/quantnet/etc/quantnet.cfg")

__HAS_CONFIG = False
for configfile in __CONFIGFILES:
    __HAS_CONFIG = __CONFIG.read(configfile) == [configfile]
    if __HAS_CONFIG:
        break

if not __HAS_CONFIG:
    log.warn(
        "No configuration file found, continuing with defaults"
        "\n\tThe quant-net server looks in the following directories for a configuration file, in order:"
        "\n\t${QUANTNET_HOME}/etc/quantnet.cfg"
        "\n\t/opt/quantnet/etc/quantnet.cfg"
        "\n\t${VIRTUAL_ENV}/etc/quantnet.cfg"
    )


class Config:
    def __init__(
        self,
        mq_broker_host: str = None,
        mq_broker_port: int = None,
        mq_mongo_host: str = None,
        mq_mongo_port: int = None,
    ):
        if mq_broker_host:
            self.mq_broker_host = mq_broker_host
        else:
            self.mq_broker_host = config_get("mq", "host", default="127.0.0.1")
        if mq_broker_port:
            self.mq_broker_port = int(mq_broker_port)
        else:
            self.mq_broker_port = int(config_get("mq", "port", default="1883"))
        if mq_mongo_host:
            self.mq_mongo_host = mq_mongo_host
        else:
            self.mq_mongo_host = config_get("mq", "mongo_host", default="127.0.0.1")
        if mq_mongo_port:
            self.mq_mongo_port = int(mq_mongo_port)
        else:
            self.mq_mongo_port = int(config_get("mq", "mongo_port", default="27017"))
        try:
            self.rpc_server_topic = config_get("mq", "rpc_server_topic")
        except Exception:
            self.rpc_server_topic = None
        try:
            self.rpc_client_topic = config_get("mq", "rpc_client_topic")
        except Exception:
            self.rpc_client_topic = None
        try:
            self.path = config_get("mq", "path")
        except Exception:
            self.path = None
        self.mq_ws_host = config_get("mq", "ws_host", default="127.0.0.1")
        self.mq_ws_port = int(config_get("mq", "ws_port", default=8080))
        self.request_types = config_get("main", "request_types", default=["spgRequest", "egpRequest", "bsmRequest"])
        try:
            self.schema_path = config_get("schemas", "path")
        except Exception:
            self.schema_path = None

    def get(self, section, option, raise_exception=True, default=None, check_config_table=True):
        return config_get(
            section,
            option,
            raise_exception=raise_exception,
            default=default,
            check_config_table=check_config_table,
        )
