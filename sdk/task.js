var fs = require('fs');
var util = require('./util');

var initTask = function (cos) {

    var queue = [];
    var tasks = {};
    var uploadingFileCount = 0;
    var nextUploadIndex = 0;

    var originApiMap = {};

    // 把上传方法替换成添加任务的方法
    util.each([
        'putObject',
        'sliceUploadFile',
    ], function (api) {
        originApiMap[api] = cos[api];
        cos[api] = function (params, callback) {
            cos._addTask(api, params, callback);
        };
    });

    // 接口返回简略的任务信息
    var formatTask = function (task) {
        var t = {
            id: task.id,
            Bucket: task.Bucket,
            Region: task.Region,
            Key: task.Key,
            FilePath: task.FilePath,
            state: task.state,
            loaded: task.loaded,
            size: task.size,
            speed: task.speed,
            percent: task.percent,
            hashPercent: task.hashPercent,
            error: task.error,
        };
        if (task.FilePath) t.FilePath = task.FilePath;
        return t;
    };

    var emitListUpdate = function () {
        cos.emit('task-list-update', {list: util.map(queue, formatTask)});
        cos.emit('list-update', {list: util.map(queue, formatTask)});
    };

    var startNextTask = function () {
        if (nextUploadIndex < queue.length &&
            uploadingFileCount < cos.options.FileParallelLimit) {
            var task = queue[nextUploadIndex];
            if (task.state === 'waiting') {
                uploadingFileCount++;
                task.state = 'checking';
                !task.params.UploadData && (task.params.UploadData = {});
                originApiMap[task.api].call(cos, task.params, function (err, data) {
                    if (!cos._isRunningTask(task.id)) return;
                    if (task.state === 'checking' || task.state === 'uploading') {
                        task.state = err ? 'error' : 'success';
                        err && (task.error = err);
                        uploadingFileCount--;
                        emitListUpdate();
                        startNextTask(cos);
                        task.callback && task.callback(err, data);
                        if (task.state === 'success') {
                            delete task.params;
                            delete task.callback;
                        }
                    }
                });
                emitListUpdate();
            }
            nextUploadIndex++;
            startNextTask(cos);
        }
    };

    var killTask = function (id, switchToState) {
        var task = tasks[id];
        if (!task) return;
        var waiting = task && task.state === 'waiting';
        var running = task && (task.state === 'checking' || task.state === 'uploading');
        if (switchToState === 'canceled' && task.state !== 'canceled' ||
            switchToState === 'paused' && waiting ||
            switchToState === 'paused' && running) {
            if (switchToState === 'paused' && task.params.Body && typeof task.params.Body.pipe === 'function') {
                console.error('stream not support pause');
                return;
            }
            task.state = switchToState;
            cos.emit('inner-kill-task', {TaskId: id});
            emitListUpdate();
            if (running) {
                uploadingFileCount--;
                startNextTask(cos);
            }
            if (switchToState === 'canceled') {
                delete task.params;
                delete task.callback;
            }
        }
    };

    cos._addTasks = function (taskList) {
        util.each(taskList, function (task) {
            task.params.IgnoreAddEvent = true;
            cos._addTask(task.api, task.params, task.callback);
        });
        emitListUpdate();
    };

    cos._addTask = function (api, params, callback) {

        // 生成 id
        var id = util.uuid();
        params.TaskReady && params.TaskReady(id);

        var size;
        if (params.Body && params.Body.size !== undefined) {
            size = params.Body.size;
        } else if (params.Body && params.Body.length !== undefined) {
            size = params.Body.length;
        } else if (params.ContentLength !== undefined) {
            size = params.ContentLength;
        } else if (params.FilePath) {
            try {
                size = fs.statSync(params.FilePath).size;
            } catch (err) {
                callback(err);
                return;
            }
        }

        if (params.ContentLength === undefined) params.ContentLength = size;
        size = size || 0;
        params.TaskId = id;

        var task = {
            // env
            params: params,
            callback: callback,
            api: api,
            index: queue.length,
            // task
            id: id,
            Bucket: params.Bucket,
            Region: params.Region,
            Key: params.Key,
            FilePath: params.FilePath || '',
            state: 'waiting',
            loaded: 0,
            size: size,
            speed: 0,
            percent: 0,
            hashPercent: 0,
            error: null,
        };
        var onHashProgress = params.onHashProgress;
        params.onHashProgress = function (info) {
            if (!cos._isRunningTask(task.id)) return;
            task.hashPercent = info.percent;
            onHashProgress && onHashProgress(info);
            emitListUpdate();
        };
        var onProgress = params.onProgress;
        params.onProgress = function (info) {
            if (!cos._isRunningTask(task.id)) return;
            task.state === 'checking' && (task.state = 'uploading');
            task.loaded = info.loaded;
            task.speed = info.speed;
            task.percent = info.percent;
            onProgress && onProgress(info);
            emitListUpdate();
        };
        queue.push(task);
        tasks[id] = task;
        !params.IgnoreAddEvent && emitListUpdate();
        startNextTask(cos);
        return id;
    };
    cos._isRunningTask = function (id) {
        var task = tasks[id];
        return !!(task && (task.state === 'checking' || task.state === 'uploading'));
    };
    cos.getTaskList = function () {
        return util.map(queue, formatTask);
    };
    cos.cancelTask = function (id) {
        killTask(id, 'canceled')
    };
    cos.pauseTask = function (id) {
        killTask(id, 'paused')
    };
    cos.restartTask = function (id) {
        var task = tasks[id];
        if (task && (task.state === 'paused' || task.state === 'error')) {
            task.state = 'waiting';
            emitListUpdate();
            nextUploadIndex = Math.min(nextUploadIndex, task.index);
            startNextTask();
        }
    };

};

module.exports.init = initTask;