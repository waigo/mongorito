/**
 * Dependencies
 */

var Class = require('class-extend');
var compose = require('koa-compose');
var monk = require('monk');
var wrap = require('co-monk');
var util = require('./util');

var isFunction = util.isFunction;
var isObject = util.isObject;
var isArray = util.isArray;


/**
 * Mongorito
 * 
 * Main class, manages mongodb connection and collections
 */

var Mongorito = {
	connect: function () {
		var urls = Array.prototype.slice.call(arguments);
		
		// convert mongo:// urls to monk-supported ones
		urls = urls.map(function (url) {
			return url.replace(/^mongo\:\/\//, '');
		});
		
		var db = monk.apply(null, urls);
		
		// if there is already a connection
		// don't overwrite it with a new one
		if (!this.db) this.db = db;
		
		return db;
	},
	
	disconnect: function () {
		this.db.close();
	},
	
	close: function () {
		return this.disconnect.apply(this, arguments);
	},
	
	collections: {},
	
	collection: function (db, name) {
	  var url = db.driver._connect_args[0];
	  var collections = this.collections[url];
	  
	  if (!collections) {
	    collections = this.collections[url] = {};
	  }
	  
	  if (collections[name]) return collections[name];
	  
		var collection = db.get(name);
		return collections[name] = wrap(collection);
	}
};


/**
 * Expose `Mongorito`
 */

var exports = module.exports = Mongorito;


/**
 * Query
 */

var Query = require('./query');


/**
 * Model
 */

var Model;

var InstanceMethods = {
	constructor: function (attrs, options) {
		this.attributes = attrs || {};
		this.changed = {};
		this.previous = {};
		this.options = options || {};
		
		// support for multiple connections
		// if model has a custom database assigned
		// use it, otherwise use the default
		var db = this.db || Mongorito.db;
		this.collection = Mongorito.collection(db, this.collection);
		
		// reset hooks
		this.hooks = {
			before: {
				create: [],
				update: [],
				remove: [],
				save: []
			},
			after: {
				create: [],
				update: [],
				remove: [],
				save: []
			}
		};
		
		// run custom per-model configuration
		this.configure();
	},
	
	get: function (key) {
		var attrs = this.attributes;
		
		return key ? attrs[key] : attrs;
	},
	
	set: function (key, value) {
		// if object passed instead of key-value pair
		// iterate and call set on each item
		if (isObject(key)) {
			var attrs = key;
			
			Object.keys(attrs).forEach(function (key) {
			  this.set(key, attrs[key]);
			}, this);
			
			return;
		}
		
		this.previous[key] = this.get(key);
		this.attributes[key] = value;
		this.changed[key] = value;
		
		return value;
	},
	
	setDefaults: function () {
	  var defaults = this.defaults || {};
	  
	  Object.keys(defaults).forEach(function (key) {
	    var defaultValue = defaults[key];
	    var actualValue = this.get(key);
	    
	    if (undefined == actualValue) {
	      this.set(key, defaultValue);
	    }
	  }, this);
	},
	
	toJSON: function () {
		return this.attributes;
	},
	
	configure: function () {
	  
	},
	
	hook: function (when, action, method) {
		if (isObject(when)) {
		  var hooks = when;
			
			Object.keys(hooks).forEach(function (key) {
			  var parts = key.split(':');
			  var when = parts[0];
			  var action = parts[1];
			  var method = hooks[key];
			  
			  this.hook(when, action, method);
			}, this);
			
			return;
		}

		if (isArray(method)) {
		  var methods = method;
		  methods.forEach(function (method) {
		    this.hook(when, action, method);
		  }, this);
		  
			return;
		}
		
		if (false === isFunction(method)) method = this[method];
		
		if ('around' === when) {
			this.hooks.before[action].push(method);
			this.hooks.after[action].unshift(method);
		} else {
			this.hooks[when][action].push(method);
		}
	},
	
	before: function (action, method) {
		this.hook('before', action, method);
	},
	
	after: function (action, method) {
		this.hook('after', action, method);
	},
	
	around: function (action, method) {
		this.hook('around', action, method);
	},
	
	runHooks: function *(when, action) {
		yield compose(this.hooks[when][action]).call(this);
	},
	
	save: function *() {
	  // set default values if needed
	  this.setDefaults();
	  
		var id = this.get('_id');
		var fn = id ? this.update : this.create;
		
		// revert populated documents to _id's
		var populate = this.options.populate || emptyObject;
		
		Object.keys(populate).forEach(function (key) {
		  var value = this.get(key);
		  
		  if (isArray(value)) {
		    value = value.map(function (doc) {
		      return doc.get('_id');
		    });
		  } else {
		    value = value.get('_id');
		  }
		  
		  this.set(key, value);
		}, this);
		
		yield this.runHooks('before', 'save');
		var result = yield fn.call(this);
		yield this.runHooks('after', 'save');
		
		return result;
	},
	
	create: function *() {
		var collection = this.collection;
		var attrs = this.attributes;
		
		var timestamp = Math.round(new Date().getTime() / 1000);
		this.set({
			created_at: timestamp,
			updated_at: timestamp
		});
		
		yield this.runHooks('before', 'create');
		
		var doc = yield collection.insert(attrs);
		this.set('_id', doc._id);
		
		yield this.runHooks('after', 'create');
		
		return this;
	},
	
	update: function *() {
		var collection = this.collection;
		var attrs = this.attributes;
		
		var timestamp = Math.round(new Date().getTime() / 1000);
		this.set('updated_at', timestamp);
		
		yield this.runHooks('before', 'update');
		yield collection.updateById(attrs._id, attrs);
		yield this.runHooks('after', 'update');
		
		return this;
	},
	
	remove: function *() {
		var collection = this.collection;
		
		yield this.runHooks('before', 'remove');
		yield collection.remove({
			_id: this.get('_id')
		});
		yield this.runHooks('after', 'remove');
		
		return this;
	}
};

var StaticMethods = {
	collection: function () {
		var name = this.prototype.collection;
		
		// support for multiple connections
		// if model has a custom database assigned
		// use it, otherwise use the default
		var db = this.prototype.db || Mongorito.db;
		
		return Mongorito.collection(db, name);
	},
	
	find: function *(query) {
		var collection = this.collection();
		var model = this;
		
		var query = new Query(collection, model).find(query);
		
		return yield query;
	},
	
	count: function *(query) {
		var collection = this.collection();
		var model = this;
		
		var count = new Query(collection, model).count(query);
		
		return yield count;
	},
	
	all: function *() {
		return yield this.find();
	},
	
	findOne: function *(query) {
		var docs = yield this.find(query);
		
		return docs[0];
	},
	
	findById: function *(id) {
		var doc = yield this.findOne({ _id: id });
		
		return doc;
	},
	
	remove: function *(query) {
		var collection = this.collection();
		var model = this;
		
		var query = new Query(collection, model).remove(query);
		
		return yield query;
	},
	
	index: function *(fields) {
		var collection = this.collection();
		
		return yield collection.index(fields);
	},
	
	indexes: function *() {
		var collection = this.collection();
		
		return yield collection.indexes();
	},
	
	id: function () {
		var collection = this.collection();
		
		return collection.id.apply(collection, arguments);
	}
};

// Setting up functions that have
// the same implementation
// and act as a bridge to Query
var methods = [
	'where',
	'limit',
	'skip',
	'sort',
	'exists', 
	'lt',
	'lte',
	'gt',
	'gte', 
	'in',
	'nin',
	'and',
	'or',
	'ne',
	'nor',
	'populate'
];

methods.forEach(function (method) {
	StaticMethods[method] = function () {
		var collection = this.collection();
		var model = this;
		
		var query = new Query(collection, model);
		query[method].apply(query, arguments);
		
		return query;
	};
});

exports.Model = Model = Class.extend(InstanceMethods, StaticMethods);

var emptyObject = {};
