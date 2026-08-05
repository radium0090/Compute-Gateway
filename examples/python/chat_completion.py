from genchi import Genchi


client = Genchi()
completion = client.chat.completions.create(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Hello from Python"}],
)
print(completion["choices"][0]["message"]["content"])

stream = client.chat.completions.stream(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Count to three"}],
)
try:
    for event in stream:
        print(event["choices"][0]["delta"].get("content", ""), end="")
    print()
finally:
    stream.close()
