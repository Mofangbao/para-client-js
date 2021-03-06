/*
 * Copyright 2013-2018 Erudika. https://erudika.com
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * For issues and patches go to: https://github.com/erudika
 */
/* global encodeURIComponent */

'use strict';

var err = console.error;
var _ = require('lodash');
var assert = require('assert');
var querystring = require('querystring');
var apiClient = require('superagent');
var AWS4Signer = require('aws4');
var RSVP = require('rsvp');
var ParaObject = require('./ParaObject');
var Pager = require('./Pager');
var Constraint = require('./Constraint');

var DEFAULT_ENDPOINT = "https://paraio.com";
var DEFAULT_PATH = "/v1/";
var JWT_PATH = "/jwt_auth";
var SEPARATOR = ":";

module.exports = ParaClient;
module.exports.ParaObject = ParaObject;
module.exports.Pager = Pager;
module.exports.Constraint = Constraint;

/**
 * JavaScript client for communicating with a Para API server.
 * @param {String} accessKey Para access key
 * @param {String} secretKey Para access key
 * @param {Object} options
 *   @property {String} endpoint the API endpoint (default: paraio.com)
 *   @property {String} apiPath the request path (default: /v1/)
 * @author Alex Bogdanovski [alex@erudika.com]
 */
function ParaClient(accessKey, secretKey, options) {
	if (!secretKey || _.isEmpty(secretKey.trim())) {
		console.warn("Secret key not provided. Make sure you call 'signIn()' first.");
	}
	options = options || {};
	this.accessKey = accessKey;
	this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
	this.apiPath = options.apiPath || DEFAULT_PATH;
	this.tokenKey = null;
	this.tokenKeyExpires = null;
	this.tokenKeyNextRefresh = null;
	if (!_.endsWith(this.apiPath, "/")) {
		this.apiPath += "/";
	}

	var that = this;
	var secret = secretKey;

	function getFullPath(resourcePath) {
		if (resourcePath && _.startsWith(resourcePath, JWT_PATH)) {
			return resourcePath;
		}
		if (!resourcePath) {
			resourcePath = '';
		} else if (resourcePath[0] === '/') {
			resourcePath = resourcePath.substring(1);
		}
		return that.apiPath + resourcePath;
	}

	this.setSecret = function(sec) {
		secret = sec;
	};

	/**
	 * Clears the JWT token from memory, if such exists.
	 */
	this.clearAccessToken = function() {
		that.tokenKey = null;
		that.tokenKeyExpires = null;
		that.tokenKeyNextRefresh = null;
	};

	/**
	 * @returns the JWT access token, or null if not signed in
	 */
	this.getAccessToken = function() {
		return that.tokenKey;
	};

	/**
	 * Sets the JWT access token.
	 * @param {String} token a valid token
	 */
	this.setAccessToken = function(token) {
		if (token && token.length > 1) {
			try {
				var parts = token.split(".");
				var decoded = JSON.parse(decode(parts[1]));
				if (decoded && decoded["exp"]) {
					that.tokenKeyExpires = decoded["exp"];
					that.tokenKeyNextRefresh = decoded["refresh"];
				}
			} catch (e) {
				that.tokenKeyExpires = null;
				that.tokenKeyNextRefresh = null;
			}
		}
		that.tokenKey = token;
	};

	/**
	 * @param {Function} fn callback (optional)
	 * @returns {RSVP.Promise} the version of Para server
	 */
	this.getServerVersion = function(fn) {
		fn = fn || _.noop;
		return that.getEntity(that.invokeGet("")).then(function (result) {
			var ver = result.version || "unknown";
			fn(ver);
			return ver;
		});
	};

	/**
	 * Invoke a GET request to the Para API.
	 * @param {String} resourcePath the subpath after '/v1/', should not start with '/'
	 * @param {Object} params query parameters
	 * @returns {Object} response
	 */
	this.invokeGet = function (resourcePath, params) {
		return invokeSignedRequest("GET", that.endpoint, getFullPath(resourcePath), null, params);
	};

	/**
	 * Invoke a POST request to the Para API.
	 * @param {String} resourcePath the subpath after '/v1/', should not start with '/'
	 * @param {Object} entity request body
	 * @returns {Object} response
	 */
	this.invokePost = function (resourcePath, entity) {
		return invokeSignedRequest("POST", that.endpoint, getFullPath(resourcePath), null, null, entity);
	};

	/**
	 * Invoke a PUT request to the Para API.
	 * @param {String} resourcePath the subpath after '/v1/', should not start with '/'
	 * @param {Object} entity request body
	 * @returns {Object} response
	 */
	this.invokePut = function (resourcePath, entity) {
		return invokeSignedRequest("PUT", that.endpoint, getFullPath(resourcePath), null, null, entity);
	};

	/**
	 * Invoke a PATCH request to the Para API.
	 * @param {String} resourcePath the subpath after '/v1/', should not start with '/'
	 * @param {Object} entity request body
	 * @returns {Object} response
	 */
	this.invokePatch = function (resourcePath, entity) {
		return invokeSignedRequest("PATCH", that.endpoint, getFullPath(resourcePath), null, null, entity);
	};

	/**
	 * Invoke a DELETE request to the Para API.
	 * @param {String} resourcePath the subpath after '/v1/', should not start with '/'
	 * @param {Object} params query parameters
	 * @returns {Object} response
	 */
	this.invokeDelete = function (resourcePath, params) {
		return invokeSignedRequest("DELETE", that.endpoint, getFullPath(resourcePath), null, params);
	};

	function invokeSignedRequest(httpMethod, endpointURL, reqPath, headers, params, jsonEntity) {
		if (!accessKey || _.isEmpty(accessKey.trim())) {
			throw "Blank access key: " + httpMethod + " " + reqPath;
		}
		var doSign = true;
		if (!secret && !that.tokenKey && _.isEmpty(headers)) {
			headers = {"Authorization": "Anonymous " + accessKey};
			doSign = false;
		}
		var host = endpointURL;
		if (_.startsWith(endpointURL, "http://")) {
			host = endpointURL.substring(7);
		} else if (_.startsWith(endpointURL, "https://")) {
			host = endpointURL.substring(8);
		}

		var opts = {
			service: 'para',
			method: httpMethod,
			host: host,
			path: uriEncodeAWSV4(reqPath),
			headers: headers || {}
		};

		// make sure that only the first parameter value is used for generating the signature
		// multi-valued parameters are reduced to single value
		// there's no spec for this case, so choose first param in array
		if (params && params instanceof Object && !_.isEmpty(params)) {
			opts.path += "?";
			var paramsObj = {};
			for (var key in params) {
				var value = params[key];
				if (_.isArray(value)) {
					if (!_.isEmpty(value)) {
						paramsObj[key] = (value[0] !== null) ? value[0] : "";
					}
				} else {
					paramsObj[key] = (value !== null) ? value : "";
				}
			}
			opts.path += querystring.stringify(paramsObj);
		}

		if (jsonEntity) {
			opts.body = JSON.stringify(jsonEntity);
			opts.headers["Content-Type"] = "application/json; charset=UTF-8";
		}

		if (that.tokenKey !== null) {
			// make sure you don't create an infinite loop!
			if (!(httpMethod === "GET" && reqPath === JWT_PATH)) {
				that.refreshToken();
			}
			opts.headers["Authorization"] = "Bearer " + that.tokenKey;
		} else if (doSign) {
			opts.doNotEncodePath = true;
			AWS4Signer.sign(opts, { accessKeyId: accessKey, secretAccessKey: secret });
		}

		if (typeof window !== "undefined") {
			// don't set the 'Host' header, the browser does that.
			delete opts.headers["Host"];
		}

		try {
			return apiClient(opts.method, endpointURL + reqPath).
					query(params).
					set(opts.headers).
					send(opts.body);
		} catch (e) {
			err("ParaClient request failed: " + e);
		}
		return null;
	}

	/**
	 * Parses a search query response and extracts the objects from it.
	 * @param {String} queryType type of search query
	 * @param {Object} params query params
	 * @param {Function} fn callback
	 * @returns {Object} response
	 */
	this.find = function (queryType, params, fn) {
		if (params && params instanceof Object && !_.isEmpty(params)) {
			var qType = queryType ? "/" + queryType : "/default";
			if (!params["type"]) {
				return that.getEntity(that.invokeGet("search" + qType, params), fn);
			} else {
				return that.getEntity(that.invokeGet(params["type"] + "/search" + qType, params), fn);
			}
		} else {
			var res = {
				"items": [],
				"totalHits": 0
			};
			fn(res);
			return resolve(res);
		}
	};

	/**
	 * Deserializes a Response object to POJO of some type.
	 * @param {Object} req request
	 * @param {Function} callback callback
	 * @param {Boolean} returnRawJSON true if raw JSON should be returned as string
	 * @returns {Object} a ParaObject
	 */
	this.getEntity =  function (req, callback, returnRawJSON) {
		callback = callback || _.noop;
		var rawJSON = _.isUndefined(returnRawJSON) ? true : returnRawJSON;
		var promise = new RSVP.Promise(function (resolve, reject) {
			if (req) {
				req.end(function (e, res) {
					//console.log("DEBUG ", req.method, req.url, res.status);
					if (e) {
						callback(null, e);
						reject(e);
					} else {
						var code = res.status;
						if (code === 200 || code === 201 || code === 304) {
							if (rawJSON) {
								var result;
								try {
									if (!_.isEmpty(res.body) || res.text === "{ }" || res.text === "{}") {
										result = res.body;
									} else {
										result = res.text;
									}
								} catch (exc) {
									result = res.text;
								}
								callback(result);
								resolve(result);
							} else {
								var obj = new ParaObject();
								obj.setFields(res.body);
								callback(obj);
								resolve(obj);
							}
						} else if (code !== 404 || code !== 304 || code !== 204) {
							var error = res.body || new Error("ParaClient request failed.");
							if (error && error["code"]) {
								var msg = error["message"] ? error["message"] : "error";
								err(msg + " - " + error["code"]);
							} else {
								err(code + " - " + res.text);
							}
							callback(null, error);
							reject(error);
						} else {
							var error = new Error("ParaClient request failed.");
							callback(null, error);
							reject(error);
						}
					}
				});
			} else {
				var error = new Error("Request object is undefined.");
				callback(null, error);
				reject(error);
			}
		});
		return promise;
	};

	/**
	 * Deserializes ParaObjects from a JSON array (the "items:[]" field in search results).
	 * @param {Array} items a list of deserialized maps
	 * @returns {Array} a list of ParaObjects
	 */
	this.getItemsFromList = function (items) {
		if (items && items instanceof Array && !_.isEmpty(items)) {
			var objects = [];
			for (var i = 0; i < items.length; i++) {
				if (items[i]) {
					var p = new ParaObject();
					p.setFields(items[i]);
					objects.push(p);
				}
			}
			return objects;
		}
		return [];
	};

	/**
	 * Converts a list of Maps to a List of ParaObjects, at a given path within the JSON tree structure.
	 * @param {Object} result the response body for an API request
	 * @param {String} at the path (field) where the array of objects is located
	 * @param {Pager} pager a pager
	 * @returns {Array} a list of ParaObjects
	 */
	this.getItemsAt = function (result, at, pager) {
		if (result && at && result[at]) {
			if (pager && result.totalHits) {
				pager.count = result.totalHits;
			}
			if (pager && result.lastKey) {
				pager.lastKey = result.lastKey;
			}
			return that.getItemsFromList(result[at]);
		}
		return [];
	};

	/**
	 * Converts a list of Maps to a List of ParaObjects.
	 * @param {Object} result the response body for an API request
	 * @param {Pager} pager a pager
	 * @returns {Array} a list of ParaObjects
	 */
	this.getItems = function (result, pager) {
		return that.getItemsAt(result, "items", pager);
	};

	/**
	 * Converts a {Pager} object to query parameters.
	 * @param {Pager} pager a pager
	 * @returns {Object} parameters map
	 */
	this.pagerToParams = function (pager) {
		var map = {};
		if (pager) {
			map["page"] = pager.page;
			map["desc"] = pager.desc;
			map["limit"] = pager.limit;
			if (pager.lastKey) {
				map["lastKey"] = pager.lastKey;
			}
			if (pager.sortby) {
				map["sort"] = pager.sortby;
			}
		}
		return map;
	};
}

function uriEncodeAWSV4(path) {
	if (!path || !_.isString(path)) {
		return "";
	}
	return encodeURIComponent(path).replace(/%2F/g, "/").
			replace(/[!'()*]/g, function(c) {
				return '%' + c.charCodeAt(0).toString(16).toUpperCase();
			});
}

function unescape(str) {
	return (str + '==='.slice((str.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
}

function decode(str, encoding) {
	return Buffer.from(unescape(str), 'base64').toString(encoding || 'utf8');
}

function resolve(obj) {
	return new RSVP.Promise(function (resolve, no) {
		resolve(obj);
	});
}

function checkParaObject(obj) {
	if (obj) {
		assert(obj instanceof ParaObject, "Parameter must be a ParaObject.");
	}
}

function checkParaObjects(obj) {
	if (obj && _.isArray(obj) && !_.isEmpty(obj)) {
		assert(obj[0] instanceof ParaObject, "Parameter must be an array of ParaObjects.");
	}
}

function checkPager(obj, fn) {
	if (obj) {
		if (_.isFunction(obj)) {
			return obj;
		} else {
			assert(obj instanceof Pager, "Parameter must be a Pager object.");
			return fn || _.noop;
		}
	}
	return _.noop;
}

function checkConstraint(obj) {
	if (obj) {
		assert(obj && obj instanceof Constraint, "Parameter must be a Constraint object.");
	}
}

/**
 * Returns the App for the current access key (appid).
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a promise
 */
ParaClient.prototype.getApp = function (fn) {
	return this.me(fn);
};

/////////////////////////////////////////////
//				 PERSISTENCE
/////////////////////////////////////////////

/**
 * Persists an object to the data store. If the object's type and id are given,
 * then the request will be a PUT request and any existing object will be
 * overwritten.
 * @param {ParaObject} obj the object to create
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the same object with assigned id or null if not created.
 */
ParaClient.prototype.create = function (obj, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj) {
		fn(null);
		return resolve(null);
	}
	if (!obj.getId() || !obj.getType()) {
		return this.getEntity(this.invokePost(obj.getType(), obj), fn, false);
	} else {
		return this.getEntity(this.invokePut(obj.getType() + "/" + obj.getId(), obj), fn, false);
	}
};

/**
 * Retrieves an object from the data store.
 * @param {String} type the type of the object
 * @param {String} id the id of the object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the retrieved object or null if not found
 */
ParaClient.prototype.read = function (type, id, fn) {
	fn = fn || _.noop;
	if (!id) {
		fn(null);
		return resolve(null);
	}
	if (!type) {
		return this.getEntity(this.invokeGet("_id/" + id), fn, false);
	} else {
		return this.getEntity(this.invokeGet(type + "/" + id), fn, false);
	}
};

/**
 * Updates an object permanently. Supports partial updates.
 * @param {ParaObject} obj the object to update
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the updated object
 */
ParaClient.prototype.update = function (obj, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj) {
		fn(null);
		return resolve(null);
	}
	return this.getEntity(this.invokePatch(obj.getObjectURI(), obj), fn, false);
};

/**
 * Deletes an object permanently.
 * @param {ParaObject} obj object to delete
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} promise
 */
ParaClient.prototype.delete = function (obj, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (obj) {
		return this.getEntity(this.invokeDelete(obj.getObjectURI()), fn);
	} else {
		fn(null);
		return resolve(null);
	}
};

/**
 * Saves multiple objects to the data store.
 * @param {Array} objects a list of ParaObjects to create
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of objects
 */
ParaClient.prototype.createAll = function (objects, fn) {
	fn = fn || _.noop;
	checkParaObjects(objects);
	if (!objects || !_.isArray(objects) || !objects[0]) {
		fn([]);
		return resolve([]);
	}
	var that = this;
	return this.getEntity(this.invokePost("_batch", objects)).then(function (result) {
		var res = that.getItemsFromList(result);
		fn(res);
		return res;
	});
};

/**
 * Retrieves multiple objects from the data store.
 * @param {Array} keys a list of object ids
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of objects
 */
ParaClient.prototype.readAll = function (keys, fn) {
	fn = fn || _.noop;
	if (!keys || !_.isArray(keys) || _.isEmpty(keys)) {
		fn([]);
		return resolve([]);
	}
	var that = this;
	return this.getEntity(this.invokeGet("_batch", {"ids": keys})).then(function (result) {
		var res = that.getItemsFromList(result);
		fn(res);
		return res;
	});
};

/**
 * Updates multiple objects.
 * @param {Array} objects a list of ParaObjects to update
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of objects
 */
ParaClient.prototype.updateAll = function (objects, fn) {
	fn = fn || _.noop;
	checkParaObjects(objects);
	if (!objects || !_.isArray(objects) || _.isEmpty(objects)) {
		fn([]);
		return resolve([]);
	}
	var that = this;
	return this.getEntity(this.invokePatch("_batch", objects)).then(function (result) {
		var res = that.getItemsFromList(result);
		fn(res);
		return res;
	});
};

/**
 * Deletes multiple objects.
 * @param {Function} fn callback (optional)
 * @param {Array} keys the ids of the objects to delete
 * @returns {RSVP.Promise} promise
 */
ParaClient.prototype.deleteAll = function (keys, fn) {
	fn = fn || _.noop;
	if (keys && _.isArray(keys)) {
		return this.getEntity(this.invokeDelete("_batch", {"ids": keys}), fn);
	} else {
		fn(null);
		return resolve(null);
	}
};

/**
 * Returns a list all objects found for the given type.
 * The result is paginated so only one page of items is returned, at a time.
 * @param {String} type the type of objects to search for
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of objects
 */
ParaClient.prototype.list = function (type, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	if (!type) {
		fn([]);
		return resolve([]);
	}
	var that = this;
	return this.getEntity(this.invokeGet(type, this.pagerToParams(pager))).then(function (result) {
		var res = that.getItems(result, pager);
		fn(res);
		return res;
	});
};

/////////////////////////////////////////////
//				 SEARCH
/////////////////////////////////////////////

/**
 * Simple id search.
 * @param {String} id the id
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the object if found or null
 */
ParaClient.prototype.findById = function (id, fn) {
	fn = fn || _.noop;
	var that = this;
	return this.find("id", {"id": id}).then(function (results) {
		var list = that.getItems(results);
		var res = _.isEmpty(list) ? null : list;
		fn(res);
		return res;
	});
};

/**
 * Simple multi id search.
 * @param {Array} ids a list of ids to search for
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of objects if found or []
 */
ParaClient.prototype.findByIds = function (ids, fn) {
	fn = fn || _.noop;
	var that = this;
	return this.find("ids", {"ids": ids}).then(function (results) {
		var res = that.getItems(results);
		fn(res);
		return res;
	});
};

/**
 * Search for address objects in a radius of X km from a given point.
 * @param {String} type the type of object to search for
 * @param {String} query the query string
 * @param {Number} radius the radius of the search circle
 * @param {Number} lat latitude
 * @param {Number} lng longitude
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findNearby = function (type, query, radius, lat, lng, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"latlng": lat + "," + lng,
		"radius": radius,
		"q": query,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("nearby", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches for objects that have a property which value starts with a given prefix.
 * @param {String} type the type of object to search for
 * @param {String} field the property name of an object
 * @param {String} prefix the prefix
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findPrefix = function (type, field, prefix, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"field": field,
		"prefix": prefix,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("prefix", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Simple query string search. This is the basic search method.
 * @param {String} type the type of object to search for
 * @param {String} query the query string
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findQuery = function (type, query, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"q": query,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches within a nested field. The objects of the given type must contain a nested field "nstd".
 * @param {String} type the type of object to search for
 * @param {String} field the name of the field to target (within a nested field "nstd")
 * @param {String} query the query string
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findNestedQuery = function (type, field, query, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"q": query,
		"field": field,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("nested", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches for objects that have similar property values to a given text. A "find like this" query.
 * @param {String} type the type of object to search for
 * @param {String} filterKey exclude an object with this key from the results (optional)
 * @param {Array} fields a list of property names
 * @param {String} liketext text to compare to
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findSimilar = function (type, filterKey, fields, liketext, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"fields": fields || null,
		"filterid": filterKey,
		"like": liketext,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("similar", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 *  Searches for objects tagged with one or more tags.
 * @param {String} type the type of object to search for
 * @param {Array} tags the list of tags
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findTagged = function (type, tags, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"tags": tags || null,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("tagged", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches for Tag objects.
 * This method might be deprecated in the future.
 * @param {String} keyword the tag keyword to search for
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findTags = function (keyword, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	keyword = keyword ? keyword + "*" : "*";
	return this.findWildcard("tag", "tag", keyword, pager, fn);
};

/**
 * Searches for objects having a property value that is in list of possible values.
 * @param {String} type the type of object to search for
 * @param {String} field the property name of an object
 * @param {Object} terms a map of terms (property values)
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findTermInList = function (type, field, terms, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"field": field,
		"terms": terms,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("in", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches for objects that have properties matching some given values. A terms query.
 * @param {String} type the type of object to search for
 * @param {Object} terms a map of fields (property names) to terms (property values)
 * @param {Boolean} matchAll match all terms. If true - AND search, if false - OR search
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findTerms = function (type, terms, matchAll, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	terms = terms || {};
	matchAll = matchAll || true;
	var params = {
		"matchall": matchAll
	};
	var list = [];
	for (var key in terms) {
		if (terms[key]) {
			list.push(key + SEPARATOR + terms[key]);
		}
	}
	if (!_.isEmpty(terms)) {
		params["terms"] = list;
	}
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("terms", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches for objects that have a property with a value matching a wildcard query.
 * @param {String} type the type of object to search for
 * @param {String} field the property name of an object
 * @param {String} wildcard wildcard query string. For example "cat*".
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of object found
 */
ParaClient.prototype.findWildcard = function (type, field, wildcard, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	var params = {
		"field": field,
		"q": wildcard,
		"type": type
	};
	params = _.merge(params, this.pagerToParams(pager));
	var that = this;
	return this.find("wildcard", params).then(function (results) {
		var res = that.getItems(results, pager);
		fn(res);
		return res;
	});
};

/**
 * Counts indexed objects matching a set of terms/values.
 * @param {String} type the type of object to search for
 * @param {Object} terms a map of fields (property names) to terms (property values)
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the number of results found
 */
ParaClient.prototype.getCount = function (type, terms, fn) {
	fn = fn || _.noop;
	if (type === null && terms === null) {
		fn(0);
		return resolve(0);
	}
	terms = terms || {};
	var params = {};
	var pager = new Pager();
	var that = this;
	params["type"] = type;
	if (_.isEmpty(terms)) {
		return this.find("count", params).then(function (results) {
			that.getItems(results, pager);
			var res = pager.count;
			fn(res);
			return res;
		});
	} else {
		var list = [];
		for (var key in terms) {
			if (terms[key]) {
				list.push(key + SEPARATOR + terms[key]);
			}
		}
		if (!_.isEmpty(terms)) {
			params["terms"] = list;
		}
		params["count"] = "true";
		return this.find("terms", params).then(function (results) {
			that.getItems(results, pager);
			var res = pager.count;
			fn(res);
			return res;
		});
	}
};

/////////////////////////////////////////////
//				 LINKS
/////////////////////////////////////////////

/**
 * Count the total number of links between this object and another type of object.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the number of links for the given object
 */
ParaClient.prototype.countLinks = function (obj, type2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn(0);
		return resolve(0);
	}
	var params = {};
	params["count"] = "true";
	var pager = new Pager();
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, params)).then(function (result) {
		that.getItems(result, pager);
		var res = pager.count;
		fn(res);
		return res;
	});
};

/**
 * Returns all objects linked to the given one. Only applicable to many-to-many relationships.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of linked objects
 */
ParaClient.prototype.getLinkedObjects = function (obj, type2, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn([]);
		return resolve([]);
	}
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, this.pagerToParams(pager))).then(function (result) {
		var res = that.getItems(result, pager);
		fn(res);
		return res;
	});
};

/**
 * Searches through all linked objects in many-to-many relationships.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {String} field the name of the field to target (within a nested field "nstd")
 * @param {String} query a query string
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of linked objects
 */
ParaClient.prototype.findLinkedObjects = function (obj, type2, field, query, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn([]);
		return resolve([]);
	}
	var params = {
		"field": field,
		"q": query || "*"
	};
	params = _.merge(params, this.pagerToParams(pager));
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, params)).then(function (result) {
		var res = that.getItems(result, pager);
		fn(res);
		return res;
	});
};

/**
 * Checks if this object is linked to another.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {String} id2 the other id
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if the two are linked
 */
ParaClient.prototype.isLinked = function (obj, type2, id2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2 || !id2) {
		fn(false);
		return resolve(false);
	}
	var url = obj.getObjectURI() + "/links/" + type2 + "/" + id2;
	return this.getEntity(this.invokeGet(url)).then(function (result) {
		var res = result === "true";
		fn(res);
		return res;
	});
};

/**
 * Checks if a given object is linked to this one.
 * @param {ParaObject} obj the object to execute this method on
 * @param {ParaObject} toObj the other object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if linked
 */
ParaClient.prototype.isLinkedToObject = function (obj, toObj, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	checkParaObject(toObj);
	if (!obj || !obj.getId() || !toObj || !toObj.getId()) {
		fn(false);
		return resolve(false);
	}
	return this.isLinked(obj, toObj.getType(), toObj.getId(), fn);
};

/**
 * Links an object to this one in a many-to-many relationship.
 * Only a link is created. Objects are left untouched.
 * The type of the second object is automatically determined on read.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} id2 the other id
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the id of the Linker object that is created
 */
ParaClient.prototype.link = function (obj, id2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !id2) {
		fn(null);
		return resolve(null);
	}
	var url = obj.getObjectURI() + "/links/" + id2;
	return this.getEntity(this.invokePost(url), fn);
};

/**
 * Unlinks an object from this one.
 * Only a link is deleted. Objects are left untouched.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {String} id2 the other id
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} promise
 */
ParaClient.prototype.unlink = function (obj, type2, id2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2 || !id2) {
		fn(null);
		return resolve(null);
	}
	var url = obj.getObjectURI() + "/links/" + type2 + "/" + id2;
	return this.getEntity(this.invokeDelete(url), fn);
};

/**
 * Unlinks all objects that are linked to this one.
 * Deletes all Linker objects.
 * Only the links are deleted. Objects are left untouched.
 * @param {ParaObject} obj the object to execute this method on
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} promise
 */
ParaClient.prototype.unlinkAll = function (obj, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId()) {
		fn(null);
		return resolve(null);
	}
	var url = obj.getObjectURI() + "/links/";
	return this.getEntity(this.invokeDelete(url), fn);
};

/**
 * Count the total number of child objects for this object.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} the number of links
 */
ParaClient.prototype.countChildren = function (obj, type2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn(0);
		return resolve(0);
	}
	var params = {};
	params["count"] = "true";
	params["childrenonly"] = "true";
	var pager = new Pager();
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, params)).then(function (result) {
		that.getItems(result, pager);
		var res = pager.count;
		fn(res);
		return res;
	});
};

/**
 * Returns all child objects linked to this object.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {String} field the field name to use as filter
 * @param {String} term the field value to use as filter
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of ParaObject in a one-to-many relationship with this object
 */
ParaClient.prototype.getChildren = function (obj, type2, field, term, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn([]);
		return resolve([]);
	}
	var params = {};
	params["childrenonly"] = "true";
	if (field) {
		params["field"] = field;
	}
	if (term) {
		params["term"] = term;
	}
	params = _.merge(params, this.pagerToParams(pager));
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, params)).then(function (result) {
		var res = that.getItems(result, pager);
		fn(res);
		return res;
	});
};

/**
 * Search through all child objects. Only searches child objects directly
 * connected to this parent via the `parentid` field.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {String} query a query string
 * @param {Pager} pager a Pager object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a list of ParaObject in a one-to-many relationship with this object
 */
ParaClient.prototype.findChildren = function (obj, type2, query, pager, fn) {
	fn = fn || _.noop;
	fn = checkPager(pager, fn);
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn([]);
		return resolve([]);
	}
	var params = {
		"childrenonly": "true",
		"q":  query || "*"
	};
	params = _.merge(params, this.pagerToParams(pager));
	var url = obj.getObjectURI() + "/links/" + type2;
	var that = this;
	return this.getEntity(this.invokeGet(url, params)).then(function (result) {
		var res = that.getItems(result, pager);
		fn(res);
		return res;
	});
};

/**
 * Deletes all child objects permanently.
 * @param {ParaObject} obj the object to execute this method on
 * @param {String} type2 the other type of object
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} promise
 */
ParaClient.prototype.deleteChildren = function (obj, type2, fn) {
	fn = fn || _.noop;
	checkParaObject(obj);
	if (!obj || !obj.getId() || !type2) {
		fn(null);
		return resolve(null);
	}
	var params = {};
	params["childrenonly"] = "true";
	var url = obj.getObjectURI() + "/links/" + type2;
	return this.getEntity(this.invokeDelete(url, params), fn);
};

/////////////////////////////////////////////
//				 UTILS
/////////////////////////////////////////////

/**
 * Generates a new unique id.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a new id
 */
ParaClient.prototype.newId = function (fn) {
	fn = fn || _.noop;
	return this.getEntity(this.invokeGet("utils/newid")).then(function (result) {
		var res = result ? result : "";
		fn(res);
		return res;
	});
};

/**
 * Returns the current timestamp.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} timestamp in milliseconds
 */
ParaClient.prototype.getTimestamp = function (fn) {
	fn = fn || _.noop;
	return this.getEntity(this.invokeGet("utils/timestamp")).then(function (result) {
		var res = result ? result : 0;
		fn(res);
		return res;
	});
};

/**
 * Formats a date in a specific format.
 * @param {String} format the date format
 * @param {String} locale the locale instance
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a formatted date
 */
ParaClient.prototype.formatDate = function (format, locale, fn) {
	var params = {"format": format || "", "locale": locale || "US"};
	return this.getEntity(this.invokeGet("utils/formatdate", params), fn);
};

/**
 * Converts spaces to dashes.
 * @param {String} str a string with spaces
 * @param {String} replaceWith a string to replace spaces with
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a string with no whitespace
 */
ParaClient.prototype.noSpaces = function (str, replaceWith, fn) {
	var params = {"string": str || "", "replacement": replaceWith || ""};
	return this.getEntity(this.invokeGet("utils/nospaces", params), fn);
};

/**
 * Strips all symbols, punctuation, whitespace and control chars from a string.
 * @param {String} str a dirty string
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a clean string
 */
ParaClient.prototype.stripAndTrim = function (str, fn) {
	var params = {"string": str || ""};
	return this.getEntity(this.invokeGet("utils/nosymbols", params), fn);
};

/**
 * Converts Markdown to HTML
 * @param {String} markdownString some Markdown
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} HTML
 */
ParaClient.prototype.markdownToHtml = function (markdownString, fn) {
	var params = {"md": markdownString || ""};
	return this.getEntity(this.invokeGet("utils/md2html", params), fn);
};

/**
 * Returns the number of minutes, hours, months elapsed for a time delta (milliseconds).
 * @param {Number} delta the time delta between two events, in milliseconds
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a string like "5m", "1h"
 */
ParaClient.prototype.approximately = function (delta, fn) {
	var params = {"delta": delta || 0};
	return this.getEntity(this.invokeGet("utils/timeago", params), fn);
};

/////////////////////////////////////////////
//				 MISC
/////////////////////////////////////////////

/**
 * Generates a new set of access/secret keys.
 * Old keys are discarded and invalid after this.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of new credentials
 */
ParaClient.prototype.newKeys = function (fn) {
	fn = fn || _.noop;
	var that = this;
	return this.getEntity(this.invokePost("_newkeys")).then(function (result) {
		var res = result || {};
		if (res.secretKey && !_.isEmpty(res.secretKey.trim())) {
			that.setSecret(res.secretKey);
		}
		fn(res);
		return res;
	});
};

/**
 * Returns all registered types for this App.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of plural-singular form of all the registered types.
 */
ParaClient.prototype.types = function (fn) {
	return this.getEntity(this.invokeGet("_types"), fn);
};

/**
 * Returns a User or an App that is currently authenticated.
 * @param {String} accessToken a valid JWT access token (optional)
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a ParaObject
 */
ParaClient.prototype.me = function (accessToken, fn) {
	fn = _.isFunction(accessToken) ? accessToken : (fn || _.noop);
	if (accessToken && _.isString(accessToken)) {
		var auth = _.startsWith(accessToken, "Bearer") ? accessToken : "Bearer" + accessToken;
		var headers = {"Authorization": auth};
		return this.getEntity(invokeSignedRequest("GET", this.endpoint, getFullPath("_me"), headers), fn, false);
	} else {
		return this.getEntity(this.invokeGet("_me"), fn, false);
	}
};

/**
 * Upvote an object and register the vote in DB.
 * @param {ParaObject} obj the object to receive +1 votes
 * @param {String} voterid the userid of the voter
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if vote was successful
 */
ParaClient.prototype.voteUp = function (obj, voterid, fn) {
	fn = fn || _.noop;
	if (!obj || _.isEmpty(voterid)) {
		fn(false);
		return resolve(false);
	}
	return this.getEntity(this.invokePatch(obj.getType() + "/" + obj.getId(), {"_voteup": voterid})).then(function (result) {
		var res = result === "true";
		fn(res);
		return res;
	});
};

/**
 * Downvote an object and register the vote in DB.
 * @param {ParaObject} obj the object to receive +1 votes
 * @param {String} voterid the userid of the voter
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if vote was successful
 */
ParaClient.prototype.voteDown = function (obj, voterid, fn) {
	fn = fn || _.noop;
	if (!obj || _.isEmpty(voterid)) {
		fn(false);
		return resolve(false);
	}
	return this.getEntity(this.invokePatch(obj.getType() + "/" + obj.getId(), {"_votedown": voterid})).then(function (result) {
		var res = result === "true";
		fn(res);
		return res;
	});
};

/**
 * Rebuilds the entire search index.
 * @param {String} destinationIndex an existing index as destination
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a response object with properties "tookMillis" and "reindexed"
 */
ParaClient.prototype.rebuildIndex = function (destinationIndex, fn) {
	fn = fn || _.noop;
	if (!destinationIndex) {
		return this.getEntity(this.invokePost("_reindex"), fn);
	} else {
		return this.getEntity(invokeSignedRequest("POST", this.endpoint, getFullPath("_reindex"), {},
			{'destinationIndex': destinationIndex}), fn);
	}
};

/////////////////////////////////////////////
//			Validation Constraints
/////////////////////////////////////////////

/**
 * Returns the validation constraints map.
 * @param {String} type a type
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map containing all validation constraints.
 */
ParaClient.prototype.validationConstraints = function (type, fn) {
	return this.getEntity(this.invokeGet("_constraints/" + (type || "")), fn);
};

/**
 * Add a new constraint for a given field.
 * @param {String} type a type
 * @param {String} field a field name
 * @param {Constraint} cons the constraint
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map containing all validation constraints for this type.
 */
ParaClient.prototype.addValidationConstraint = function (type, field, cons, fn) {
	fn = fn || _.noop;
	checkConstraint(cons);
	if (!type || !field || !cons) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokePut("_constraints/" + type + "/" + field + "/" + cons.getName(), cons.getPayload()), fn);
};

/**
 * Removes a validation constraint for a given field.
 * @param {String} type a type
 * @param {String} field a field name
 * @param {String} constraintName the name of the constraint to remove
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map containing all validation constraints for this type.
 */
ParaClient.prototype.removeValidationConstraint = function (type, field, constraintName, fn) {
	fn = fn || _.noop;
	if (!type || !field || !constraintName) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokeDelete("_constraints/" + type + "/" + field + "/" + constraintName), fn);
};

/////////////////////////////////////////////
//			Resource Permissions
/////////////////////////////////////////////

/**
 * Returns only the permissions for a given subject (user) of the current app.
 * If subject is not given returns the permissions for all subjects and resources for current app.
 * @param {String} subjectid the subject id (user id)
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of subject ids to resource names to a list of allowed methods
 */
ParaClient.prototype.resourcePermissions = function(subjectid, fn) {
	if (!subjectid) {
		return this.getEntity(this.invokeGet("_permissions"), fn);
	} else {
		return this.getEntity(this.invokeGet("_permissions/" + subjectid), fn);
	}
};

/**
 * Grants a permission to a subject that allows them to call the specified HTTP methods on a given resource.
 * @param {String} subjectid subject id (user id)
 * @param {String} resourcePath resource path or object type
 * @param {Array} permission a set of HTTP methods
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of the permissions for this subject id
 */
ParaClient.prototype.grantResourcePermission = function(subjectid, resourcePath, permission, fn) {
	return grantResourcePermission(subjectid, resourcePath, permission, false, fn);
};

/**
 * Grants a permission to a subject that allows them to call the specified HTTP methods on a given resource.
 * @param {String} subjectid subject id (user id)
 * @param {String} resourcePath resource path or object type
 * @param {Array} permission a set of HTTP methods
 * @param {Boolean} allowGuestAccess if true - all unauthenticated requests will go through, 'false' by default.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of the permissions for this subject id
 */
ParaClient.prototype.grantResourcePermission = function(subjectid, resourcePath, permission, allowGuestAccess, fn) {
	fn = fn || _.noop;
	if (!subjectid || !resourcePath || !permission || !_.isArray(permission)) {
		fn({});
		return resolve({});
	}
	if (allowGuestAccess && subjectid === "*") {
		permission.push("?");
	}
	resourcePath = encodeURIComponent(resourcePath);
	return this.getEntity(this.invokePut("_permissions/" + subjectid + "/" + resourcePath, permission), fn);
};

/**
 * Revokes a permission for a subject, meaning they no longer will be able to access the given resource.
 * @param {String} subjectid subject id (user id)
 * @param {String} resourcePath resource path or object type
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of the permissions for this subject id
 */
ParaClient.prototype.revokeResourcePermission = function(subjectid, resourcePath, fn) {
	fn = fn || _.noop;
	if (!subjectid || !resourcePath) {
		fn({});
		return resolve({});
	}
	resourcePath = encodeURIComponent(resourcePath);
	return this.getEntity(this.invokeDelete("_permissions/" + subjectid + "/" + resourcePath), fn);
};

/**
 * Revokes all permission for a subject.
 * @param {String} subjectid subject id (user id)
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map of the permissions for this subject id
 */
ParaClient.prototype.revokeAllResourcePermissions = function(subjectid, fn) {
	fn = fn || _.noop;
	if (!subjectid) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokeDelete("_permissions/" + subjectid), fn);
};

/**
 * Checks if a subject is allowed to call method X on resource Y.
 * @param {String} subjectid subject id
 * @param {String} resourcePath resource path or object type
 * @param {String} httpMethod HTTP method name
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if allowed
 */
ParaClient.prototype.isAllowedTo = function(subjectid, resourcePath, httpMethod, fn) {
	fn = fn || _.noop;
	if (!subjectid || !resourcePath || !httpMethod) {
		fn(false);
		return resolve(false);
	}
	resourcePath = encodeURIComponent(resourcePath);
	var url = "_permissions/" + subjectid + "/" + resourcePath + "/" + httpMethod;
	return this.getEntity(this.invokeGet(url)).then(function (result) {
		var res = result === "true";
		fn(res);
		return res;
	}).catch(function (err) {
		fn(false);
		return false;
	});
};

/////////////////////////////////////////////
//			Resource Permissions
/////////////////////////////////////////////

/**
 * Returns the value of a specific app setting (property) or all settings if key is blank.
 * @param {String} key a key
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a map
 */
ParaClient.prototype.appSettings = function(key, fn) {
	fn = fn || _.noop;
	if (!key || _.isEmpty(key.trim())) {
		return this.getEntity(this.invokeGet("_settings"), fn);
	} else {
		return this.getEntity(this.invokeGet("_settings/" + key.trim()), fn);
	}
};

/**
 * Adds or overwrites an app-specific setting.
 * @param {String} key a key
 * @param {Object} value a value
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} void
 */
ParaClient.prototype.addAppSetting = function(key, value, fn) {
	fn = fn || _.noop;
	if (!key || _.isEmpty(key.trim()) || !value | _.isEmpty(value)) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokePut("_settings/" + key.trim(), {value: value}), fn);
};

/**
 * Overwrites all app-specific settings.
 * @param {Object} settings a key-value map of properties
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} void
 */
ParaClient.prototype.setAppSettings = function(settings, fn) {
	fn = fn || _.noop;
	if (!settings) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokePut("_settings", settings), fn);
};

/**
 * Removes an app-specific setting.
 * @param {String} key a key
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} void
 */
ParaClient.prototype.removeAppSetting = function(key, fn) {
	fn = fn || _.noop;
	if (!key || _.isEmpty(key)) {
		fn({});
		return resolve({});
	}
	return this.getEntity(this.invokeDelete("_settings/" + key.trim()), fn);
};

/////////////////////////////////////////////
//				Access Tokens
/////////////////////////////////////////////

/**
 * Takes an identity provider access token and fetches the user data from that provider.
 * A new User object is created if that user doesn't exist.
 * Access tokens are returned upon successful authentication using one of the SDKs from
 * Facebook, Google, Twitter, etc.
 * <b>Note:</b> Twitter uses OAuth 1 and gives you a token and a token secret.
 * <b>You must concatenate them like this: <code>{oauth_token}:{oauth_token_secret}</code> and
 * use that as the provider access token.</b>
 * @param {String} provider identity provider, e.g. 'facebook', 'google'...
 * @param {String} providerToken access token from a provider like Facebook, Google, Twitter
 * @param {Boolean} rememberJWT if true, the access token returned by Para will be saved and available via getAccessToken()
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} a User object or null if something failed
 */
ParaClient.prototype.signIn = function(provider, providerToken, rememberJWT, fn) {
	var rememberToken = _.isBoolean(rememberJWT) ? rememberJWT : true;
	fn = _.isFunction(rememberJWT) ? rememberJWT : (fn || _.noop);

	if (provider && providerToken) {
		var credentials = {};
		var that = this;
		credentials["appid"] = that.accessKey;
		credentials["provider"] = provider;
		credentials["token"] = providerToken;
		return this.getEntity(this.invokePost(JWT_PATH, credentials)).then(function (result) {
			if (result !== null && result["user"] && result["jwt"]) {
				var jwtData = result["jwt"];
				if (jwtData && rememberToken) {
					that.tokenKey = jwtData["access_token"];
					that.tokenKeyExpires = jwtData["expires"];
					that.tokenKeyNextRefresh = jwtData["refresh"];
				}
				var user = new ParaObject();
				user.setFields(result["user"]);
				fn(user);
				return user;
			} else {
				that.clearAccessToken();
			}
			fn(null);
			return null;
		}).catch(function (err) {
			fn(null);
			return null;
		});
	}
	fn(null);
	return null;
};

/**
 * Clears the JWT access token but token is not revoked.
 * Tokens can be revoked globally per user with revokeAllTokens().
 */
ParaClient.prototype.signOut = function() {
	this.clearAccessToken();
};

/**
 * Refreshes the JWT access token. This requires a valid existing token.
 * Call link signIn() first.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if token was refreshed
 */
ParaClient.prototype.refreshToken = function(fn) {
	fn = fn || _.noop;
	var that = this;
	var now = new Date().getTime();
	var notExpired = that.tokenKeyExpires !== null && that.tokenKeyExpires > now;
	var canRefresh = that.tokenKeyNextRefresh !== null && (
			that.tokenKeyNextRefresh < now ||
			that.tokenKeyNextRefresh > that.tokenKeyExpires);
	// token present and NOT expired
	if (that.tokenKey !== null && notExpired && canRefresh) {
		return this.getEntity(this.invokeGet(JWT_PATH)).then(function (result) {
			if (result !== null && result["user"] && result["jwt"]) {
				var jwtData = result["jwt"];
				that.tokenKey = jwtData["access_token"];
				that.tokenKeyExpires = jwtData["expires"];
				that.tokenKeyNextRefresh = jwtData["refresh"];
				fn(true);
				return true;
			} else {
				that.clearAccessToken();
			}
			fn(false);
			return false;
		}).catch(function (err) {
			fn(false);
			return false;
		});
	}
	fn(false);
	return false;
};

/**
 * Revokes all user tokens for a given user id.
 * This would be equivalent to "logout everywhere".
 * <b>Note:</b> Generating a new API secret on the server will also invalidate all client tokens.
 * Requires a valid existing token.
 * @param {Function} fn callback (optional)
 * @returns {RSVP.Promise} true if successful
 */
ParaClient.prototype.revokeAllTokens = function(fn) {
	fn = fn || _.noop;
	return this.getEntity(this.invokeDelete(JWT_PATH)).then(function (result) {
		var res = result !== null;
		fn(res);
		return res;
	}).catch(function (err) {
		fn(false);
		return false;
	});
};
