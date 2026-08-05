# Examples

These examples target a running Genchi gateway and read credentials from
environment variables so they are never stored in source files.

Set the client key and, if necessary, override the local base URL:

```bash
export GENCHI_API_KEY='<client-key>'
export GENCHI_BASE_URL='http://localhost:8080/v1'
```

Run the curl example:

```bash
sh examples/curl/chat-completion.sh
```

Build the workspace and run the Node.js example against the repository SDK:

```bash
pnpm build
node examples/node/chat-completion.mjs
```

Run the Python example against the repository SDK:

```bash
PYTHONPATH=sdk/python/src python3 examples/python/chat_completion.py
```

The Node.js and Python examples include streaming and explicitly close their
iterators when the consumer stops.
