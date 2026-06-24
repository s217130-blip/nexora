async function run() {
  const res = await fetch("https://nexora.s217130.workers.dev/api/dictionary/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: "apple" })
  });
  console.log(res.status, await res.text());
  console.log(Object.fromEntries(res.headers));
}
run();
