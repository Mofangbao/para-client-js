![Logo](https://s3-eu-west-1.amazonaws.com/org.paraio/para.png)
============================

# JavaScript Client for Para [![NPM version][npm-image]][npm-url]

## What is this?

**Para** was designed as a simple and modular back-end framework for object persistence and retrieval.
It enables your application to store objects directly to a data store (NoSQL) or any relational database (RDBMS)
and it also automatically indexes those objects and makes them searchable.

This is the JavaScript client for Para.

## Quick start

```sh
$ npm install --save para-client-js
```

## Usage

```js
var ParaClient = require('para-client-js');
var pc = new ParaClient('ACCESS_KEY', 'SECRET_KEY');
```

## Promises and callbacks

All methods return a promise object and also accept a callback function as last parameter.
You can choose to either use callbacks or promises. For example:

```js
// using promises
pc.read("user", "1234").then(function (user) {
	// do something with user object
}, function (err) {
	// request failed
});

// using callbacks
pc.read("user", "1234", function (user, err) {
	// do something with user object
});
```

## Documentation

###[Read the Docs](http://paraio.org/docs)

## Contributing

1. Fork this repository and clone the fork to your machine
2. Create a branch (`git checkout -b my-new-feature`)
3. Implement a new feature or fix a bug and add some tests
4. Commit your changes (`git commit -am 'Added a new feature'`)
5. Push the branch to **your fork** on GitHub (`git push origin my-new-feature`)
6. Create new Pull Request from your fork

For more information see [CONTRIBUTING.md](https://github.com/Erudika/para/blob/master/CONTRIBUTING.md)

## License
[Apache 2.0](LICENSE)

[npm-image]: https://badge.fury.io/js/para-client-js.svg
[npm-url]: https://npmjs.org/package/para-client-js
