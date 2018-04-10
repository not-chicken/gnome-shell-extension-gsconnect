"use strict";

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: "org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP",
    incomingCapabilities: ["kdeconnect.sftp"],
    outgoingCapabilities: ["kdeconnect.sftp.request"],
    actions: {
        // TODO: stateful action???
        mount: {
            summary: _("Browse Files"),
            description: _("Mount a remote device"),
            icon_name: "folder-remote-symbolic",

            signature: null,
            incoming: ["kdeconnect.sftp"],
            outgoing: ["kdeconnect.sftp.request"],
            allow: 6
        },
        unmount: {
            summary: _("Stop Browsing"),
            description: _("Unmount a remote device"),
            signature: "(ssav)",
            incoming: ["kdeconnect.sftp"],
            outgoing: ["kdeconnect.sftp.request"],
            allow: 6
        }
    },
    events: {}
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 *
 * TODO: see #40 & #54 by @getzze
 * TODO: the Android app source that says SSHFS < 3.3 and causes data corruption
 *
 * {
 *     "id": 1518956413092,
 *     "type":"kdeconnect.sftp",
 *     "body": {
 *         "ip": "192.168.1.71",
 *         "port": 1743,
 *         "user": "kdeconnect",
 *         "password": "UzcNCrI7T668JyxUFjOxQncBPNcO",
 *         "path": "/storage/emulated/0",
 *         "multiPaths": ["/storage/emulated/0","/storage/emulated/0/DCIM/Camera"],
 *         "pathNames":["All files","Camera pictures"]
 *     }
 * }
 */
var Plugin = GObject.registerClass({
    Name: "GSConnectSFTPPlugin",
    Properties: {
        "directories": GObject.param_spec_variant(
            "directories",
            "mountedDirectories",
            "Directories on the mounted device",
            new GLib.VariantType("a{sv}"),
            null,
            GObject.ParamFlags.READABLE
        ),
        "mounted": GObject.ParamSpec.boolean(
            "mounted",
            "deviceMounted",
            "Whether the device is mounted",
            GObject.ParamFlags.READABLE,
            false
        ),
        "port": GObject.ParamSpec.uint(
            "port",
            "SFTP Port",
            "The port used for SFTP communication",
            GObject.ParamFlags.READABLE,
            1739, 1764,
            1739
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, "sftp");

        if (!gsconnect.checkCommand("sshfs")) {
            this.destroy();
            throw Error(_("SSHFS not installed"));
        }

        this._path = gsconnect.runtimedir + "/" + this.device.id;
        GLib.mkdir_with_parents(this._path, 448);

        this._mounted = false;
        this._directories = {};

        if (this.settings.get_boolean("automount")) {
            this.mount();
        }
    }

    get directories () { return this._directories || {}; }
    get mounted () { return this._mounted || false }
    get port () { return this._port || 0; }

    handlePacket(packet) {
        debug(packet);

        // FIXME FIXME FIXME
        if (packet.type === "kdeconnect.sftp") {
            this._parseConnectionData(packet);
        }
    }

    _parseConnectionData(packet) {
        this._ip = packet.body.ip;
        this._port = packet.body.port;
        this._root = packet.body.path;

        this._user = packet.body.user;
        this._password = packet.body.password;

        // Set the directories and notify (client.js needs this before mounted)
        for (let index in packet.body.pathNames) {
            if (packet.body.multiPaths[index].indexOf(this._root) === 0 ) {
                let name = packet.body.pathNames[index];
                let path = packet.body.multiPaths[index].replace(this._root, "");
                this._directories[name] = this._path + path;
            }
        }

        // FIXME: shouldn't automount, but should auto-probe for info
        this._mount(packet);
    }

    _mount(packet) {
        let dir = Gio.File.new_for_path(this._path);
        let info = dir.query_info("unix::uid,unix::gid", 0, null);
        this._uid = info.get_attribute_uint32("unix::uid").toString();
        this._gid = info.get_attribute_uint32("unix::gid").toString();

        let args = [
            "sshfs",
            `${this._user}@${this._ip}:${this._root}`,
            this._path,
            "-p", this._port.toString(),
            // "disable multi-threaded operation"
            // Fixes file chunks being sent out of order and corrupted
            "-s",
            // "foreground operation"
            "-f",
            // Do not use ~/.ssh/config
            "-F", "/dev/null",
            // Sketchy?
            "-o", "IdentityFile=" + gsconnect.configdir + "/private.pem",
            // Don't prompt for new host confirmation (we know the host)
            "-o", "StrictHostKeyChecking=no",
            // Prevent storing as a known host
            "-o", "UserKnownHostsFile=/dev/null",
            // ssh-dss (DSA) keys are deprecated since openssh-7.0p1
            // See: https://bugs.kde.org/show_bug.cgi?id=351725
            "-o", "HostKeyAlgorithms=ssh-dss",
            // Match keepalive for kdeconnect connection (30sx3)
            "-o", "ServerAliveInterval=30",
            // Automatically reconnect to server if connection is interrupted
            "-o", "reconnect",
            // Set user/group permissions to allow readwrite access
            "-o", `uid=${this._uid}`, "-o", `gid=${this._gid}`,
            // "read password from stdin (only for pam_mount!)"
            "-o", "password_stdin"
        ];

        // [res, pid, in_fd, out_fd, err_fd]
        try {
            this._proc = GLib.spawn_async_with_pipes(
                null,                                   // working dir
                args,                                   // argv
                null,                                   // envp
                GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
                null                                    // child_setup (func)
            );
        } catch (e) {
            log("SFTP: Error mounting '" + this.device.name + "': " + e);
            this.unmount();
            return e;
        }

        });

        this._stderr = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: this._proc[4] })
        });

        let source = this._stderr.base_stream.create_source(null);
        source.set_callback(this._read_stderr.bind(this));
        source.attach(null);

        // Send session password
        let stdin = new Gio.DataOutputStream({
            base_stream: new Gio.UnixOutputStream({
                close_fd: false,
                fd: this._proc[2]
            })
        });
        stdin.put_string(this._password + "\n", null);
        stdin.close(null);

        // FIXME: move to _parseConnectionData()
        this.notify("directories");

        // Set "mounted" and notify
        this._mounted = true;
        this.notify("mounted");

        return true;
    }

    _read_stderr() {
        // unmount() was called with data in the queue
        if (!this._stderr) { return; }

        this._stderr.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            let [data, len] = source.read_line_finish(res);

            // TODO: there's no way this covers all the bases
            if (data === null) {
                log("SFTP Error: pipe closed");
                this.unmount();
            } else {
                switch (data.toString()) {
                    case "remote host has disconnected":
                        debug("Sftp: disconnected");
                        this.unmount();
                    case "Timeout waiting for prompt":
                        this.unmount("Sftp: timeout");
                    default:
                        log("Sftp: " + data.toString());
                }
            }
        });
    }

    mount() {
        debug("SFTP: mount()");

        this.device.sendPacket({
            id: 0,
            type: "kdeconnect.sftp.request",
            body: { startBrowsing: true }
        });
    }

    unmount() {
        debug("SFTP: unmount()");

        try {
            if (this._proc) {
               GLib.spawn_command_line_async("kill -9 " + this._proc[1]);
            }
        } catch (e) {
            log("SFTP: Error killing sshfs: " + e);
        }

        if (this._path) {
            if (gsconnect.checkCommand("fusermount")) {
                GLib.spawn_command_line_async("fusermount -uz " + this._path);
            } else {
                GLib.spawn_command_line_async("umount " + this._path);
            }

            delete this._path;
            delete this._uid;
            delete this._gid;
        }

        try {
            if (this._stderr) {
                this._stderr.close(null);
            }
        } catch (e) {
            log("SFTP: Error closing stderr: " + e);
        }

        delete this._proc;
        delete this._stderr;

        this._directories = {};
        this.notify("directories");

        this._mounted = false;
        this.notify("mounted");
    }

    destroy() {
        if (this.mounted) {
            this.unmount();
        }

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

