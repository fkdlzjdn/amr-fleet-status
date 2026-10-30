"""ROS1 adapters for the shared live readers and guarded IO state machine."""
import concurrent.futures
import io
import os
import socket
import threading
import time
import types
import xmlrpc.client


class Ros1Transport(xmlrpc.client.Transport):
    def make_connection(self, host):
        connection = super().make_connection(host)
        connection.timeout = 0.6
        return connection


class Ros1Client:
    def __init__(self, node, kind, name):
        self.node, self.kind, self.name = node, kind, name

    def service_is_ready(self):
        return self.node.service_verified(self.name, self.kind._type)

    def call_async(self, request):
        future = concurrent.futures.Future()
        started = time.monotonic()

        def call():
            try:
                # Recheck ownership and type immediately before a single call.
                if not self.service_is_ready() or time.monotonic() - started > 0.8:
                    raise RuntimeError('IO service owner changed')
                result = self.node.rospy.ServiceProxy(self.name, self.kind, persistent=False)(request)
                future.set_result(result)
            except Exception as error:
                future.set_exception(error)
        threading.Thread(target=call, daemon=True).start()
        return future


class Ros1Node:
    """Expose only the graph/subscription operations used by our existing readers."""
    def __init__(self, name):
        import rospy
        self.rospy = rospy
        rospy.init_node(name, anonymous=True, disable_signals=True, disable_rosout=True)
        self.caller = rospy.get_name()
        self.master = xmlrpc.client.ServerProxy(os.environ.get('ROS_MASTER_URI') or 'http://localhost:11311',
                                                transport=Ros1Transport())
        self.subscriptions, self.state, self.topics, self.last_graph = [], None, [], 0
        self.expected_driver = None
        self.graph_lock = threading.RLock()

    def graph(self):
        with self.graph_lock:
            self.refresh_graph()
            return self.state, self.topics

    def refresh_graph(self):
        now = time.monotonic()
        if now - self.last_graph < 0.2 and self.state is not None:
            return
        self.state, self.topics = None, []
        code, _, state = self.master.getSystemState(self.caller)
        code2, _, topics = self.master.getPublishedTopics(self.caller, '')
        if code != 1 or code2 != 1:
            raise RuntimeError('ROS master unavailable')
        self.state, self.topics, self.last_graph = state, topics, now

    @staticmethod
    def compatible_type(kind):
        return kind.replace('spx_msgs/', 'spx_io_msgs/msg/') if kind.startswith('spx_msgs/') else kind.replace('/', '/msg/', 1)

    def get_node_names_and_namespaces(self):
        state, _ = self.graph()
        names = set(node for group in state for _, nodes in group for node in nodes)
        return [(name.rsplit('/', 1)[-1], name.rsplit('/', 1)[0] or '/') for name in sorted(names)]

    def get_topic_names_and_types(self):
        _, topics = self.graph()
        return [(name, [self.compatible_type(kind)]) for name, kind in topics]

    def get_publisher_names_and_types_by_node(self, name, namespace):
        target = namespace.rstrip('/') + '/' + name
        self.expected_driver = target
        state, topics = self.graph()
        owned = {topic for topic, nodes in state[0] if target in nodes}
        return [(topic, [self.compatible_type(kind)]) for topic, kind in topics if topic in owned]

    def get_publishers_info_by_topic(self, topic):
        state, _ = self.graph()
        owners = next((nodes for name, nodes in state[0] if name == topic), [])
        return [types.SimpleNamespace(node_name=name.rsplit('/', 1)[-1], node_namespace=name.rsplit('/', 1)[0] or '/')
                for name in owners]

    def create_subscription(self, kind, topic, callback, _qos):
        def receive(message):
            # ROS1 connection metadata identifies the actual transport publisher.
            sender = getattr(message, '_connection_header', {}).get('callerid')
            with self.graph_lock:
                owners = next((nodes for name, nodes in (self.state or [[], [], []])[0] if name == topic), [])
                owners = list(owners)
            if len(owners) != 1:
                return
            if sender == owners[0]:
                callback(message)
        subscription = self.rospy.Subscriber(topic, kind, receive, queue_size=1, tcp_nodelay=True)
        self.subscriptions.append(subscription)
        return subscription

    def service_verified(self, name, kind):
        state, _ = self.graph()
        owners = next((nodes for service, nodes in state[2] if service == name), [])
        if not self.expected_driver or owners != [self.expected_driver]:
            return False
        headers = self.service_headers(name)
        return headers.get('callerid') == self.expected_driver and headers.get('type') == kind

    def service_headers(self, name):
        import rosgraph.network
        with self.graph_lock:
            code, _, uri = self.master.lookupService(self.caller, name)
        if code != 1:
            return {}
        host, port = self.rospy.parse_rosrpc_uri(uri)
        # The probe handshake only reads metadata; it never invokes the service.
        with socket.create_connection((host, port), timeout=0.5) as stream:
            stream.settimeout(0.5)
            rosgraph.network.write_ros_handshake_header(stream, {'probe': '1', 'md5sum': '*', 'callerid': self.caller, 'service': name})
            return rosgraph.network.read_ros_handshake_header(stream, io.BytesIO(), 2048)

    def get_service_names_and_types_by_node(self, name, namespace):
        self.expected_driver = namespace.rstrip('/') + '/' + name
        result = []
        for suffix, kind in [('set_output', 'SetOutput'), ('get_input', 'GetInput')]:
            service = namespace.rstrip('/') + '/io/' + suffix
            if self.service_verified(service, 'spx_msgs/' + kind):
                result.append((service, ['spx_io_msgs/srv/' + kind]))
        return result

    def create_client(self, kind, name):
        return Ros1Client(self, kind, name)

    def publisher_pid(self, name):
        with self.graph_lock:
            code, _, uri = self.master.lookupNode(self.caller, name)
        if code != 1:
            return None
        code, _, pid = xmlrpc.client.ServerProxy(uri, transport=Ros1Transport()).getPid(self.caller)
        return pid if code == 1 else None

    def destroy_node(self):
        for subscription in self.subscriptions:
            subscription.unregister()
        self.rospy.signal_shutdown('Fleet reader disconnected')
