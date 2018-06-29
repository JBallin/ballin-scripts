Quickly switch between light and dark themes in Atom on the command line!

**Usage**

* `$ theme` - toggle theme
* `$ theme d` - dark theme
* `$ theme l` - light theme

**Set Up**
```shell
$ cd ~
$ git clone https://github.com/jballin_scripts.git
$ mv jballin_scripts .jballin_scripts # hide folder
$ cd jballin/atom_theme
$ npm install
$ ln -s $HOME/.jballin_scripts/atom_theme/bin/theme /usr/local/bin # symlink script to path
```

**Troubleshooting**

Make sure `/usr/local/bin` is in your path by running `echo $PATH`. If not, add below to your profile/rc file and open a new terminal window.

```shell
export PATH=/usr/local/bin:$PATH
```
