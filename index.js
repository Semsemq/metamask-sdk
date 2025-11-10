// If the Snap is not already installed, the user will be prompted to install it.
await window.ethereum.request({
  method: "wallet_requestSnaps",
  params: {
    // Assuming the Snap is published to npm using the package name "hello-snap".
    "npm:hello-snap": {},
  },
})

// Invoke the "hello" JSON-RPC method exposed by the Snap.
const response = await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: { snapId: "npm:hello-snap", request: { method: "hello" } },
})

console.log(response) // "world!"
