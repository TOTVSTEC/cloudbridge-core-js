/****************************************************************************
**
** Copyright (C) 2016 The Qt Company Ltd.
** Copyright (C) 2016 Klarälvdalens Datakonsult AB, a KDAB Group company, info@kdab.com, author Milian Wolff <milian.wolff@kdab.com>
** Contact: https://www.qt.io/licensing/
**
** This file is part of the QtWebChannel module of the Qt Toolkit.
**
** $QT_BEGIN_LICENSE:LGPL$
** Commercial License Usage
** Licensees holding valid commercial Qt licenses may use this file in
** accordance with the commercial license agreement provided with the
** Software or, alternatively, in accordance with the terms contained in
** a written agreement between you and The Qt Company. For licensing terms
** and conditions see https://www.qt.io/terms-conditions. For further
** information use the contact form at https://www.qt.io/contact-us.
**
** GNU Lesser General Public License Usage
** Alternatively, this file may be used under the terms of the GNU Lesser
** General Public License version 3 as published by the Free Software
** Foundation and appearing in the file LICENSE.LGPL3 included in the
** packaging of this file. Please review the following information to
** ensure the GNU Lesser General Public License version 3 requirements
** will be met: https://www.gnu.org/licenses/lgpl-3.0.html.
**
** GNU General Public License Usage
** Alternatively, this file may be used under the terms of the GNU
** General Public License version 2.0 or (at your option) the GNU General
** Public license version 3 or any later version approved by the KDE Free
** Qt Foundation. The licenses are as published by the Free Software
** Foundation and appearing in the file LICENSE.GPL2 and LICENSE.GPL3
** included in the packaging of this file. Please review the following
** information to ensure the GNU General Public License requirements will
** be met: https://www.gnu.org/licenses/gpl-2.0.html and
** https://www.gnu.org/licenses/gpl-3.0.html.
**
** $QT_END_LICENSE$
**
****************************************************************************/

"use strict";

var QWebChannelMessageTypes = {
    signal: 1,
    propertyUpdate: 2,
    init: 3,
    idle: 4,
    debug: 5,
    invokeMethod: 6,
    connectToSignal: 7,
    disconnectFromSignal: 8,
    setProperty: 9,
    response: 10,
};

var QWebChannel = function(transport, initCallback)
{
    if (typeof transport !== "object" || typeof transport.send !== "function") {
        console.error("The QWebChannel expects a transport object with a send function and onmessage callback property." +
                      " Given is: transport: " + typeof(transport) + ", transport.send: " + typeof(transport.send));
        return;
    }

    var channel = this;
    this.transport = transport;

    this.send = function(data)
    {
        if (typeof(data) !== "string") {
            data = JSON.stringify(data);
        }
        channel.transport.send(data);
    }

    this.transport.onmessage = function(message)
    {
        var data = message.data;
        if (typeof data === "string") {
            data = JSON.parse(data);
        }
        switch (data.type) {
            case QWebChannelMessageTypes.signal:
                channel.handleSignal(data);
                break;
            case QWebChannelMessageTypes.response:
                channel.handleResponse(data);
                break;
            case QWebChannelMessageTypes.propertyUpdate:
                channel.handlePropertyUpdate(data);
                break;
            default:
                console.error("invalid message received:", message.data);
                break;
        }
    }

    this.execCallbacks = {};
    this.execId = 0;
    this.exec = function(data, callback)
    {
        if (!callback) {
            // if no callback is given, send directly
            channel.send(data);
            return;
        }
        if (channel.execId === Number.MAX_VALUE) {
            // wrap
            channel.execId = Number.MIN_VALUE;
        }
        if (data.hasOwnProperty("id")) {
            console.error("Cannot exec message with property id: " + JSON.stringify(data));
            return;
        }
        data.id = channel.execId++;
        channel.execCallbacks[data.id] = callback;
        channel.send(data);
    };

    this.objects = {};

    this.handleSignal = function(message)
    {
        var object = channel.objects[message.object];
        if (object) {
            object.signalEmitted(message.signal, message.args);
        } else {
            console.warn("Unhandled signal: " + message.object + "::" + message.signal);
        }
    }

    this.handleResponse = function(message)
    {
        if (!message.hasOwnProperty("id")) {
            console.error("Invalid response message received: ", JSON.stringify(message));
            return;
        }
        channel.execCallbacks[message.id](message.data);
        delete channel.execCallbacks[message.id];
    }

    this.handlePropertyUpdate = function(message)
    {
        for (var i in message.data) {
            var data = message.data[i];
            var object = channel.objects[data.object];
            if (object) {
                object.propertyUpdate(data.signals, data.properties);
            } else {
                console.warn("Unhandled property update: " + data.object + "::" + data.signal);
            }
        }
        channel.exec({type: QWebChannelMessageTypes.idle});
    }

    this.debug = function(message)
    {
        channel.send({type: QWebChannelMessageTypes.debug, data: message});
    };

    channel.exec({type: QWebChannelMessageTypes.init}, function(data) {
        for (var objectName in data) {
            var object = new QObject(objectName, data[objectName], channel);
        }
        // now unwrap properties, which might reference other registered objects
        for (var objectName in channel.objects) {
            channel.objects[objectName].unwrapProperties();
        }

        // TOTVS - verificar as linhas abaixo antes de alterar o arquivo
        channel.exec({type: QWebChannelMessageTypes.idle});

        if (initCallback) {
            setTimeout(initCallback.bind(null, channel),0);
        }
        //END TOTVS
    });
};

function QObject(name, data, webChannel)
{
    this.__id__ = name;
    webChannel.objects[name] = this;

    // List of callbacks that get invoked upon signal emission
    this.__objectSignals__ = {};

    // Cache of all properties, updated when a notify signal is emitted
    this.__propertyCache__ = {};

    var object = this;

    // ----------------------------------------------------------------------

    this.unwrapQObject = function(response)
    {
        if (response instanceof Array) {
            // support list of objects
            var ret = new Array(response.length);
            for (var i = 0; i < response.length; ++i) {
                ret[i] = object.unwrapQObject(response[i]);
            }
            return ret;
        }
        if (!response
            || !response["__QObject*__"]
            || response.id === undefined) {
            return response;
        }

        var objectId = response.id;
        if (webChannel.objects[objectId])
            return webChannel.objects[objectId];

        if (!response.data) {
            console.error("Cannot unwrap unknown QObject " + objectId + " without data.");
            return;
        }

        var qObject = new QObject( objectId, response.data, webChannel );
        qObject.destroyed.connect(function() {
            if (webChannel.objects[objectId] === qObject) {
                delete webChannel.objects[objectId];
                // reset the now deleted QObject to an empty {} object
                // just assigning {} though would not have the desired effect, but the
                // below also ensures all external references will see the empty map
                // NOTE: this detour is necessary to workaround QTBUG-40021
                var propertyNames = [];
                for (var propertyName in qObject) {
                    propertyNames.push(propertyName);
                }
                for (var idx in propertyNames) {
                    delete qObject[propertyNames[idx]];
                }
            }
        });
        // here we are already initialized, and thus must directly unwrap the properties
        qObject.unwrapProperties();
        return qObject;
    }

    this.unwrapProperties = function()
    {
        for (var propertyIdx in object.__propertyCache__) {
            object.__propertyCache__[propertyIdx] = object.unwrapQObject(object.__propertyCache__[propertyIdx]);
        }
    }

    function addSignal(signalData, isPropertyNotifySignal)
    {
        var signalName = signalData[0];
        var signalIndex = signalData[1];
        object[signalName] = {
            connect: function(callback) {
                if (typeof(callback) !== "function") {
                    console.error("Bad callback given to connect to signal " + signalName);
                    return;
                }

                object.__objectSignals__[signalIndex] = object.__objectSignals__[signalIndex] || [];
                object.__objectSignals__[signalIndex].push(callback);

                if (!isPropertyNotifySignal && signalName !== "destroyed") {
                    // only required for "pure" signals, handled separately for properties in propertyUpdate
                    // also note that we always get notified about the destroyed signal
                    webChannel.exec({
                        type: QWebChannelMessageTypes.connectToSignal,
                        object: object.__id__,
                        signal: signalIndex
                    });
                }
            },
            disconnect: function(callback) {
                if (typeof(callback) !== "function") {
                    console.error("Bad callback given to disconnect from signal " + signalName);
                    return;
                }
                object.__objectSignals__[signalIndex] = object.__objectSignals__[signalIndex] || [];
                var idx = object.__objectSignals__[signalIndex].indexOf(callback);
                if (idx === -1) {
                    console.error("Cannot find connection of signal " + signalName + " to " + callback.name);
                    return;
                }
                object.__objectSignals__[signalIndex].splice(idx, 1);
                if (!isPropertyNotifySignal && object.__objectSignals__[signalIndex].length === 0) {
                    // only required for "pure" signals, handled separately for properties in propertyUpdate
                    webChannel.exec({
                        type: QWebChannelMessageTypes.disconnectFromSignal,
                        object: object.__id__,
                        signal: signalIndex
                    });
                }
            }
        };
    }

    /**
     * Invokes all callbacks for the given signalname. Also works for property notify callbacks.
     */
    function invokeSignalCallbacks(signalName, signalArgs)
    {
        var connections = object.__objectSignals__[signalName];
        if (connections) {
            connections.forEach(function(callback) {
                callback.apply(callback, signalArgs);
            });
        }
    }

    this.propertyUpdate = function(signals, propertyMap)
    {
        // update property cache
        for (var propertyIndex in propertyMap) {
            var propertyValue = propertyMap[propertyIndex];
            object.__propertyCache__[propertyIndex] = propertyValue;
        }

        for (var signalName in signals) {
            // Invoke all callbacks, as signalEmitted() does not. This ensures the
            // property cache is updated before the callbacks are invoked.
            invokeSignalCallbacks(signalName, signals[signalName]);
        }
    }

    this.signalEmitted = function(signalName, signalArgs)
    {
        invokeSignalCallbacks(signalName, signalArgs);
    }

    function addMethod(methodData)
    {
        var methodName = methodData[0];
        var methodIdx = methodData[1];
        object[methodName] = function() {
            var args = [];
            var callback;
            for (var i = 0; i < arguments.length; ++i) {
                if (typeof arguments[i] === "function")
                    callback = arguments[i];
                else
                    args.push(arguments[i]);
            }

            webChannel.exec({
                "type": QWebChannelMessageTypes.invokeMethod,
                "object": object.__id__,
                "method": methodIdx,
                "args": args
            }, function(response) {
                if (response !== undefined) {
                    var result = object.unwrapQObject(response);
                    if (callback) {
                        (callback)(result);
                    }
                }
            });
        };
    }

    function bindGetterSetter(propertyInfo)
    {
        var propertyIndex = propertyInfo[0];
        var propertyName = propertyInfo[1];
        var notifySignalData = propertyInfo[2];
        // initialize property cache with current value
        // NOTE: if this is an object, it is not directly unwrapped as it might
        // reference other QObject that we do not know yet
        object.__propertyCache__[propertyIndex] = propertyInfo[3];

        if (notifySignalData) {
            if (notifySignalData[0] === 1) {
                // signal name is optimized away, reconstruct the actual name
                notifySignalData[0] = propertyName + "Changed";
            }
            addSignal(notifySignalData, true);
        }

        Object.defineProperty(object, propertyName, {
            configurable: true,
            get: function () {
                var propertyValue = object.__propertyCache__[propertyIndex];
                if (propertyValue === undefined) {
                    // This shouldn't happen
                    console.warn("Undefined value in property cache for property \"" + propertyName + "\" in object " + object.__id__);
                }

                return propertyValue;
            },
            set: function(value) {
                if (value === undefined) {
                    console.warn("Property setter for " + propertyName + " called with undefined value!");
                    return;
                }
                object.__propertyCache__[propertyIndex] = value;
                webChannel.exec({
                    "type": QWebChannelMessageTypes.setProperty,
                    "object": object.__id__,
                    "property": propertyIndex,
                    "value": value
                });
            }
        });

    }

    // ----------------------------------------------------------------------

    data.methods.forEach(addMethod);

    data.properties.forEach(bindGetterSetter);

    data.signals.forEach(function(signal) { addSignal(signal, false); });

    for (var name in data.enums) {
        object[name] = data.enums[name];
    }
}

//required for use with nodejs
if (typeof module === 'object') {
    module.exports = {
        QWebChannel: QWebChannel
    };
}

var TOTVS;
(function (TOTVS) {
    var PromiseQueue = (function () {
        function PromiseQueue(maxPendingPromises, maxQueuedPromises) {
            this.pendingPromises = 0;
            this.maxPendingPromises = typeof maxPendingPromises !== 'undefined' ? maxPendingPromises : 1;
            this.maxQueuedPromises = typeof maxQueuedPromises !== 'undefined' ? maxQueuedPromises : Infinity;
            this.queue = [];
        }
        PromiseQueue.prototype.add = function (promiseGenerator) {
            var self = this;
            return new Promise(function (resolve, reject, notify) {
                if (self.queue.length >= self.maxQueuedPromises) {
                    reject(new Error('Queue limit reached'));
                    return;
                }
                self.queue.push({
                    promiseGenerator: promiseGenerator,
                    resolve: resolve,
                    reject: reject,
                    notify: notify || self.noop
                });
                self._dequeue();
            });
        };
        PromiseQueue.prototype.noop = function () {
        };
        PromiseQueue.prototype.setMaxPendingPromises = function (length) {
            var diff = (length - this.maxPendingPromises);
            this.maxPendingPromises = length;
            for (; diff > 0; diff--) {
                this._dequeue();
            }
        };
        PromiseQueue.prototype.getPendingLength = function () {
            return this.pendingPromises;
        };
        PromiseQueue.prototype.getQueueLength = function () {
            return this.queue.length;
        };
        PromiseQueue.prototype._dequeue = function () {
            var self = this;
            if (this.pendingPromises >= this.maxPendingPromises) {
                return false;
            }
            var item = this.queue.shift();
            if (!item) {
                return false;
            }
            try {
                this.pendingPromises++;
                this.resolveWith(item.promiseGenerator())
                    .then(function (value) {
                    self.pendingPromises--;
                    item.resolve(value);
                    self._dequeue();
                }, function (err) {
                    self.pendingPromises--;
                    item.reject(err);
                    self._dequeue();
                }, function (message) {
                    item.notify(message);
                });
            }
            catch (err) {
                self.pendingPromises--;
                item.reject(err);
                self._dequeue();
            }
            return true;
        };
        PromiseQueue.prototype.resolveWith = function (value) {
            if (value && typeof value.then === 'function') {
                return value;
            }
            return new Promise(function (resolve) {
                resolve(value);
            });
        };
        return PromiseQueue;
    }());
    TOTVS.PromiseQueue = PromiseQueue;
})(TOTVS || (TOTVS = {}));
//# sourceMappingURL=promisequeue.js.map
var TOTVS;
(function (TOTVS) {
    var TWebChannel = (function () {
        function TWebChannel(port, callback) {
            this.internalWSPort = -1;
            this.queue = new TOTVS.PromiseQueue(0);
            if (window['Promise'] !== undefined) {
                this.__send = this.__send_promise;
            }
            else {
                this.__send = this.__send_callback;
            }
            if ((callback === undefined) && (typeof port === 'function')) {
                callback = port;
                port = undefined;
            }
            if (port !== undefined) {
                if (typeof port !== 'number')
                    throw new TypeError('Parameter "port" must be numeric.');
                this.internalWSPort = port;
            }
            if (this.internalWSPort === -1) {
                throw new Error('Parameter "port" must be numeric.');
            }
            if (this.internalWSPort > -1) {
                var _this = this;
                var baseUrl = "ws://127.0.0.1:" + this.internalWSPort;
                var socket = new WebSocket(baseUrl);
                socket.onclose = function () {
                    console.error("WebChannel closed");
                };
                socket.onerror = function (error) {
                    console.error("WebChannel error: " + error);
                };
                socket.onopen = function () {
                    _this.qwebchannel = new QWebChannel(socket, function (channel) {
                        _this.dialog = channel.objects.mainDialog;
                        _this.dialog.advplToJs.connect(function (codeType, codeContent, objectName) {
                            if (codeType == "js") {
                                var scriptRef = document.createElement('script');
                                scriptRef.setAttribute("type", "text/javascript");
                                scriptRef.innerText = codeContent;
                                document.getElementsByTagName("head")[0].appendChild(scriptRef);
                            }
                            else if (codeType == "css") {
                                var linkRef = document.createElement("link");
                                linkRef.setAttribute("rel", "stylesheet");
                                linkRef.setAttribute("type", "text/css");
                                linkRef.innerText = codeContent;
                                document.getElementsByTagName("head")[0].appendChild(linkRef);
                            }
                        });
                        if (typeof callback === 'function')
                            callback();
                        _this.queue.setMaxPendingPromises(1);
                    });
                };
            }
        }
        TWebChannel.start = function (port) {
            if (TWebChannel.instance === null) {
                var channel = new TWebChannel(port, function () {
                    TWebChannel.instance = channel;
                    if (window) {
                        window['cloudbridge'] = channel;
                    }
                    TWebChannel.emit('cloudbridgeready');
                });
            }
            else {
                TWebChannel.emit('cloudbridgeready');
            }
        };
        TWebChannel.emit = function (name) {
            var event = new CustomEvent(name, {
                'detail': {
                    'channel': TWebChannel.instance
                }
            });
            event["channel"] = TWebChannel.instance;
            document.dispatchEvent(event);
        };
        TWebChannel.prototype.runAdvpl = function (command, callback) {
            return this.__send("runAdvpl", command, callback);
        };
        TWebChannel.prototype.getPicture = function (callback) {
            return this.__send("getPicture", "", callback);
        };
        TWebChannel.prototype.barCodeScanner = function (callback) {
            return this.__send("barCodeScanner", "", callback);
        };
        TWebChannel.prototype.pairedDevices = function (callback) {
            return this.__send("pairedDevices", "", callback);
        };
        TWebChannel.prototype.unlockOrientation = function (callback) {
            return this.__send("unlockOrientation", "", callback);
        };
        TWebChannel.prototype.lockOrientation = function (callback) {
            return this.__send("lockOrientation", "", callback);
        };
        TWebChannel.prototype.getCurrentPosition = function (callback) {
            return this.__send("getCurrentPosition", "", callback);
        };
        TWebChannel.prototype.testDevice = function (feature, callback) {
            return this.__send("testDevice", String(feature), callback);
        };
        TWebChannel.prototype.createNotification = function (options, callback) {
            return this.__send("createNotification", options, callback);
        };
        TWebChannel.prototype.openSettings = function (feature, callback) {
            return this.__send("openSettings", String(feature), callback);
        };
        TWebChannel.prototype.getTempPath = function (callback) {
            return this.__send("getTempPath", "", callback);
        };
        TWebChannel.prototype.vibrate = function (milliseconds, callback) {
            return this.__send("vibrate", milliseconds, callback);
        };
        TWebChannel.prototype.dbGet = function (query, callback) {
            return this.__send("dbGet", query, callback);
        };
        TWebChannel.prototype.dbExec = function (query, callback) {
            return this.__send("dbExec", query, callback);
        };
        TWebChannel.prototype.dbExecuteScalar = function (query, callback) {
            return this.__send("DBEXECSCALAR", query, callback);
        };
        TWebChannel.prototype.dbBegin = function (callback) {
            return this.__send("dbBegin", "", callback);
        };
        TWebChannel.prototype.dbCommit = function (callback, onError) {
            return this.__send("dbCommit", "", callback);
        };
        TWebChannel.prototype.dbRollback = function (callback) {
            return this.__send("dbRollback", "", callback);
        };
        TWebChannel.prototype.sendMessage = function (content, callback) {
            return this.__send("MESSAGE", content, callback);
        };
        TWebChannel.prototype.__send_promise = function (id, content, onSuccess, onError) {
            var _this = this;
            var promise = this.queue.add(function () {
                return new Promise(function (resolve, reject) {
                    try {
                        _this.dialog.jsToAdvpl(id, _this.__JSON_stringify(content), function (data) {
                            resolve(_this.__JSON_parse(data));
                            if ((onSuccess) && (typeof onSuccess === 'function')) {
                                onSuccess(data);
                            }
                        });
                    }
                    catch (error) {
                        reject(error);
                        if ((onError) && (typeof onError === 'function')) {
                            onError(error);
                        }
                    }
                });
            });
            return promise;
        };
        TWebChannel.prototype.__send_callback = function (id, content, onSuccess, onError) {
            var _this = this;
            try {
                if (typeof onSuccess === 'function') {
                    _this.dialog.jsToAdvpl(id, _this.__JSON_stringify(content), function (data) {
                        onSuccess(_this.__JSON_parse(data));
                    });
                }
                else {
                    _this.dialog.jsToAdvpl(id, _this.__JSON_stringify(content), null);
                }
            }
            catch (error) {
                if ((onError) && (typeof onError === 'function')) {
                    onError(error);
                }
                else {
                    throw error;
                }
            }
        };
        TWebChannel.prototype.__JSON_stringify = function (data) {
            if (data === null) {
                return null;
            }
            else if (typeof data === "string") {
                return data;
            }
            else {
                if ((Array.isArray(data)) || (typeof data === "object")) {
                    return TWebChannel.JSON_FLAG + JSON.stringify(data) + TWebChannel.JSON_FLAG;
                }
            }
            return JSON.stringify(data);
        };
        TWebChannel.prototype.__JSON_parse = function (data) {
            if (typeof data === 'string') {
                var flag = TWebChannel.JSON_FLAG;
                if (data.length >= (2 + (flag.length * 2))) {
                    var begin = flag.length, end = data.length - flag.length;
                    if ((data.substr(0, begin) === flag) && (data.substr(end) === flag)) {
                        return JSON.parse(data.substring(begin, end));
                    }
                }
            }
            return data;
        };
        TWebChannel.instance = null;
        TWebChannel.version = "0.1.4";
        TWebChannel.BLUETOOTH_FEATURE = 1;
        TWebChannel.NFC_FEATURE = 2;
        TWebChannel.WIFI_FEATURE = 3;
        TWebChannel.LOCATION_FEATURE = 4;
        TWebChannel.CONNECTED_WIFI = 5;
        TWebChannel.CONNECTED_MOBILE = 6;
        TWebChannel.JSON_FLAG = "#JSON#";
        return TWebChannel;
    }());
    TOTVS.TWebChannel = TWebChannel;
})(TOTVS || (TOTVS = {}));
//# sourceMappingURL=totvs-twebchannel.js.map