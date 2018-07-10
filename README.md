**Installation**

Clone this repo in `$HOME`, make it a hidden "dot file", and run the initialization script.

```shell
$ cd $HOME && git clone https://github.com/JBallin/ballin-scripts.git && mv ballin-scripts .ballin-scripts && .ballin-scripts/bin/init
```

**Usage**

See README's in folders.

**Troubleshooting**

Make sure `/usr/local/bin` is in your path by running `echo $PATH`. If not, add below to your profile/rc file and open a new terminal window.

```shell
export PATH=/usr/local/bin:$PATH
```
